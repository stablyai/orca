import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { prepareRelayAsiaTopologyInput } from './prepare-relay-asia-topology-input.mjs'

const image = `us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:${'a'.repeat(64)}`

const additionalRegions = { 'asia-east2': '10.42.1.0/24' }

const productionCells = () => Object.fromEntries([
  [27, 'asia-east2-a'],
  [28, 'asia-east2-b'],
  [29, 'asia-east2-c'],
  [30, 'asia-east2-a'],
  [31, 'asia-east2-b'],
  [32, 'us-central1-a'],
  [33, 'us-central1-b']
].map(([ordinal, zone]) => [`production-gce-c${ordinal}`, {
    hostname: `c${ordinal}`, region: zone.slice(0, -2), zone,
    machine_type: 'e2-standard-4', boot_disk_gb: 30,
    boot_image: 'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21',
    capacity_requests: 6_000, database_pool_max: zone.startsWith('asia-') ? 16 : 10, image,
    initially_enabled: false,
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
    capacity_requests: 6_000, database_pool_max: 16, image, initially_enabled: false,
    connection_hard_cap: 3_000, connection_unobserved_bound: 60
  })
})

test('accepts the additive C30 wave without re-planning the launch cells', () => {
  const result = prepareRelayAsiaTopologyInput({ existingCells: productionCells(),
    existingAdditionalRegions: additionalRegions, environment: 'production',
    cellIds: 'production-gce-c30', image })
  assert.equal(result.relay_gce_cells['production-gce-c30'].zone, 'asia-east2-a')
})

test('accepts the additive C31 wave in the next zone of the rotation', () => {
  const result = prepareRelayAsiaTopologyInput({ existingCells: productionCells(),
    existingAdditionalRegions: additionalRegions, environment: 'production',
    cellIds: 'production-gce-c31', image })
  assert.equal(result.relay_gce_cells['production-gce-c31'].zone, 'asia-east2-b')
})

test('accepts the additive US C32+C33 wave at the default pool only', () => {
  const cellIds = 'production-gce-c32,production-gce-c33'
  for (const [cellId, zone] of [
    ['production-gce-c32', 'us-central1-a'], ['production-gce-c33', 'us-central1-b']
  ]) {
    const result = prepareRelayAsiaTopologyInput({ existingCells: productionCells(),
      existingAdditionalRegions: additionalRegions, environment: 'production', cellIds, image })
    assert.equal(result.relay_gce_cells[cellId].zone, zone)
    assert.equal(result.relay_gce_cells[cellId].region, 'us-central1')
    // Copying the Asia pool onto a US cell is drift, not the reviewed shape.
    const asiaPool = productionCells()
    asiaPool[cellId].database_pool_max = 16
    assert.throws(() => prepareRelayAsiaTopologyInput({ existingCells: asiaPool,
      existingAdditionalRegions: additionalRegions, environment: 'production', cellIds, image
    }), /differs from the reviewed topology/)
    const asiaRegion = productionCells()
    asiaRegion[cellId].region = 'asia-east2'
    assert.throws(() => prepareRelayAsiaTopologyInput({ existingCells: asiaRegion,
      existingAdditionalRegions: additionalRegions, environment: 'production', cellIds, image
    }), /differs from the reviewed topology/)
  }
})

// Reads the committed file so a reviewed-shape constant cannot drift from what the plan reads.
test('matches every committed production Asia cell entry', () => {
  const tfvars = readFileSync(
    new URL('../../infra/terraform/environments/production.tfvars', import.meta.url),
    'utf8'
  )
  const committed = {}
  for (const cellId of Object.keys(productionCells())) {
    const start = tfvars.indexOf(`  "${cellId}" = {`)
    assert.notEqual(start, -1, `${cellId} is not committed`)
    const body = tfvars.slice(start, tfvars.indexOf('\n  }', start))
    const cell = {}
    for (const [, key, raw] of body.matchAll(/^\s+([a-z_]+)\s+=\s+("[^"]*"|\S+)/gm)) {
      cell[key] = raw.startsWith('"') ? raw.slice(1, -1)
        : raw === 'true' || raw === 'false' ? raw === 'true' : Number(raw)
    }
    committed[cellId] = cell
  }
  // Each wave is pinned on its own: C30-C33 launch on the director's digest, not C27's.
  for (const wave of [
    'production-gce-c27,production-gce-c28,production-gce-c29',
    'production-gce-c30',
    'production-gce-c31',
    'production-gce-c32,production-gce-c33'
  ]) {
    const committedImage = committed[wave.split(',')[0]].image
    assert.doesNotThrow(() => prepareRelayAsiaTopologyInput({
      existingCells: committed, existingAdditionalRegions: additionalRegions,
      environment: 'production', cellIds: wave, image: committedImage
    }), wave)
  }
  assert.throws(() => prepareRelayAsiaTopologyInput({
    existingCells: committed, existingAdditionalRegions: additionalRegions,
    environment: 'production', cellIds: 'production-gce-c30',
    image
  }), /differs from the reviewed topology/)
  // The US cells launch on the newest digest, the one C31 launched on.
  for (const cellId of ['production-gce-c32', 'production-gce-c33']) {
    assert.equal(committed[cellId].image, committed['production-gce-c31'].image, cellId)
  }
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
  for (const cellIds of [
    'production-gce-c27',
    'production-gce-c27,production-gce-c30',
    'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30',
    'production-gce-c30,production-gce-c30',
    'production-gce-c30,production-gce-c31',
    'production-gce-c32',
    'production-gce-c33',
    'production-gce-c34'
  ]) {
    assert.throws(() => prepareRelayAsiaTopologyInput({
      existingCells: productionCells(), existingAdditionalRegions: additionalRegions,
      environment: 'production', cellIds, image
    }), /cell IDs/, cellIds)
  }
  const poolDrift = productionCells()
  poolDrift['production-gce-c30'].database_pool_max = 10
  assert.throws(() => prepareRelayAsiaTopologyInput({
    existingCells: poolDrift, existingAdditionalRegions: additionalRegions,
    environment: 'production', cellIds: 'production-gce-c30', image
  }), /differs from the reviewed topology/)
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
