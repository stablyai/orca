import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareRelayAsiaTopologyInput } from './prepare-relay-asia-topology-input.mjs'

const image = `us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:${'a'.repeat(64)}`

const additionalRegions = { 'asia-east2': '10.42.1.0/24' }

const productionCells = () => Object.fromEntries([
  [27, 'asia-east2-a'],
  [28, 'asia-east2-b'],
  [29, 'asia-east2-c']
].map(([ordinal, zone]) => [`production-gce-c${ordinal}`, {
    hostname: `c${ordinal}`, region: 'asia-east2', zone,
    machine_type: 'e2-standard-4', boot_disk_gb: 30,
    boot_image: 'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21',
    capacity_requests: 6_000, database_pool_max: 10, image, initially_enabled: false,
    connection_hard_cap: 3_000, connection_unobserved_bound: 60
  }]))

test('accepts the exact production topology only after it is durably committed', () => {
  const existing = {
    'production-gce-c26': { hostname: 'c26', image: 'existing' },
    ...productionCells()
  }
  const result = prepareRelayAsiaTopologyInput({ existingCells: existing,
    existingAdditionalRegions: additionalRegions, environment: 'production',
    cellIds: 'production-gce-c27,production-gce-c28,production-gce-c29', image })
  assert.equal(result.relay_gce_cells, existing)
  assert.equal(result.relay_gce_additional_region_subnetwork_cidrs, additionalRegions)
  assert.deepEqual(existing['production-gce-c27'], {
    hostname: 'c27', region: 'asia-east2', zone: 'asia-east2-a',
    machine_type: 'e2-standard-4', boot_disk_gb: 30,
    boot_image: 'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21',
    capacity_requests: 6_000, database_pool_max: 10, image, initially_enabled: false,
    connection_hard_cap: 3_000, connection_unobserved_bound: 60
  })
})

test('accepts the one exact committed staging Asia cell', () => {
  const stagingImage = image.replace('onorca-cloud/', 'onorca-cloud-staging/')
  const stagingCell = {
    hostname: 'c4', region: 'asia-east2', zone: 'asia-east2-a',
    machine_type: 'e2-standard-4', boot_disk_gb: 30,
    boot_image: 'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21',
    capacity_requests: 6_000, database_pool_max: 10, image: stagingImage,
    initially_enabled: false, connection_hard_cap: 3_000,
    connection_unobserved_bound: 60
  }
  const result = prepareRelayAsiaTopologyInput({
    existingCells: { 'staging-gce-c3': { hostname: 'c3' }, 'staging-gce-c4': stagingCell },
    existingAdditionalRegions: additionalRegions,
    environment: 'staging',
    cellIds: 'staging-gce-c4',
    image: stagingImage
  })
  assert.equal(result.relay_gce_cells['staging-gce-c4'].zone, 'asia-east2-a')
  assert.equal(result.relay_gce_cells['staging-gce-c4'].image, stagingImage)
})

test('rejects an uncommitted subnet or cell, partial wave, wrong image, and drift', () => {
  assert.throws(() => prepareRelayAsiaTopologyInput({
    existingCells: productionCells(), existingAdditionalRegions: additionalRegions,
    environment: 'production', cellIds: 'production-gce-c27', image
  }), /cell IDs/)
  assert.throws(() => prepareRelayAsiaTopologyInput({
    existingCells: productionCells(), existingAdditionalRegions: additionalRegions,
    environment: 'production',
    cellIds: 'production-gce-c27,production-gce-c28,production-gce-c29',
    image: image.replace('onorca-cloud/', 'other-project/')
  }), /environment Relay image/)
  assert.throws(() => prepareRelayAsiaTopologyInput({
    existingCells: productionCells(), existingAdditionalRegions: {}, environment: 'production',
    cellIds: 'production-gce-c27,production-gce-c28,production-gce-c29', image
  }), /subnet must be committed/)
  const missing = productionCells()
  delete missing['production-gce-c29']
  assert.throws(() => prepareRelayAsiaTopologyInput({
    existingCells: missing, existingAdditionalRegions: additionalRegions, environment: 'production',
    cellIds: 'production-gce-c27,production-gce-c28,production-gce-c29', image
  }), /cells must be committed/)
  assert.throws(() => prepareRelayAsiaTopologyInput({
    existingCells: { ...productionCells(), 'production-gce-c27': {} },
    existingAdditionalRegions: additionalRegions, environment: 'production',
    cellIds: 'production-gce-c27,production-gce-c28,production-gce-c29', image
  }), /differs from the reviewed topology/)
})
