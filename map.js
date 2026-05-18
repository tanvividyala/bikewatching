import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@3.21.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

mapboxgl.accessToken = 'pk.eyJ1IjoidHZpZHlhbGEiLCJhIjoiY205amwzOXltMGNzajJpcG93eHhzc2tnMiJ9.gCPbybhkFNppmdRtQJVpAA';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/tvidyala/cmpae905j001101s3a8gg92gy',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

const svg = d3.select('#map').select('svg');

// Pre-bucketed trips for performance (one bucket per minute of the day)
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute   = Array.from({ length: 1440 }, () => []);

function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) return tripsByMinute.flat();
  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;
  if (minMinute > maxMinute) {
    return departuresByMinute === tripsByMinute
      ? tripsByMinute.slice(minMinute).concat(tripsByMinute.slice(0, maxMinute)).flat()
      : tripsByMinute.slice(minMinute).concat(tripsByMinute.slice(0, maxMinute)).flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );
  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );
  return stations.map((station) => {
    const id = station.short_name;
    station.arrivals     = arrivals.get(id)   ?? 0;
    station.departures   = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

const stationFlow = d3.scaleQuantize()
  .domain([0, 1])
  .range(['#B8403F', '#D98453', '#7A9B70']); // arrivals → balanced → departures

const bikeLanePaint = {
  'line-color': '#7A9B70',
  'line-width': 3,
  'line-opacity': 0.6,
};

map.on('load', async () => {
  // --- Bike lanes ---
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({ id: 'boston-bike-lanes', type: 'line', source: 'boston_route', paint: bikeLanePaint });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({ id: 'cambridge-bike-lanes', type: 'line', source: 'cambridge_route', paint: bikeLanePaint });

  // --- Stations ---
  let stations = [];
  try {
    const jsonData = await d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json');
    stations = jsonData.data.stations;
  } catch (error) {
    console.error('Error loading stations:', error);
  }

  // --- Traffic (parsed + bucketed) ---
  try {
    await d3.csv(
      'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
      (trip) => {
        trip.started_at = new Date(trip.started_at);
        trip.ended_at   = new Date(trip.ended_at);
        departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
        arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);
        return trip;
      },
    );
  } catch (error) {
    console.error('Error loading traffic data:', error);
  }

  // Compute initial traffic (all trips)
  stations = computeStationTraffic(stations);

  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // --- Draw circles ---
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .attr('fill', (d) => stationFlow(d.departures / d.totalTraffic))
    .attr('stroke', 'white')
    .attr('stroke-width', 1)
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
    });

  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move',    updatePositions);
  map.on('zoom',    updatePositions);
  map.on('resize',  updatePositions);
  map.on('moveend', updatePositions);

  // --- Time filter ---
  const timeSlider   = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);
    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .attr('fill', (d) => stationFlow(d.departures / d.totalTraffic));
  }

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);
    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }
    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});

map.on('error', (e) => console.error('Map error:', e));
