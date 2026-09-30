import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareRelayAsiaDirectorCells } from './prepare-relay-asia-director-cells.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const topologyCell = (ordinal, zone) => ({
  origin: `https://c${ordinal}.relay.onorca.dev`, region: 'asia-east2', zone,
  capacity_requests: 6_000, database_pool_max: 16,
  connection_hard_cap: 3_000, connection_unobserved_bound: 60,
  initially_enabled: false,
  image: `us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@${digest}`
})

test('preserves current order, defaults predecessor regions, and appends exact Asia cells', () => {
  const current = [{
    id: 'production-gce-c1', url: 'https://c1.relay.onorca.dev',
    capacityRequests: 4_000, initiallyEnabled: false
  }]
  const result = prepareRelayAsiaDirectorCells({
    currentCells: current,
    topology: {
      'production-gce-c27': topologyCell(27, 'asia-east2-a'),
      'production-gce-c28': topologyCell(28, 'asia-east2-b'),
      'production-gce-c29': topologyCell(29, 'asia-east2-c')
    },
    cellIds: 'production-gce-c27,production-gce-c28,production-gce-c29',
    imageDigest: digest
  })
  assert.equal(result[0].region, 'us-central1')
  assert.deepEqual(result.slice(1).map(({ id }) => id), [
    'production-gce-c27', 'production-gce-c28', 'production-gce-c29'
  ])
  assert.ok(result.slice(1).every((cell) =>
    cell.region === 'asia-east2' && cell.initiallyEnabled === false &&
    cell.connectionHardCap === 3_000
  ))
})

test('is idempotent for an exact existing Asia cell and rejects director drift', () => {
  const topology = { 'production-gce-c27': topologyCell(27, 'asia-east2-a') }
  const current = prepareRelayAsiaDirectorCells({
    currentCells: [], topology, cellIds: 'production-gce-c27', imageDigest: digest
  })
  assert.deepEqual(prepareRelayAsiaDirectorCells({
    currentCells: current, topology, cellIds: 'production-gce-c27', imageDigest: digest
  }), current)
  assert.throws(() => prepareRelayAsiaDirectorCells({
    currentCells: [{ ...current[0], capacityRequests: 5_999 }],
    topology, cellIds: 'production-gce-c27', imageDigest: digest
  }), /director configuration differs/)
})

test('appends C30 after the configured launch cells without touching them', () => {
  const launch = prepareRelayAsiaDirectorCells({
    currentCells: [],
    topology: {
      'production-gce-c27': topologyCell(27, 'asia-east2-a'),
      'production-gce-c28': topologyCell(28, 'asia-east2-b'),
      'production-gce-c29': topologyCell(29, 'asia-east2-c')
    },
    cellIds: 'production-gce-c27,production-gce-c28,production-gce-c29',
    imageDigest: digest
  })
  const result = prepareRelayAsiaDirectorCells({
    currentCells: launch,
    topology: { 'production-gce-c30': topologyCell(30, 'asia-east2-a') },
    cellIds: 'production-gce-c30',
    imageDigest: digest
  })
  assert.deepEqual(result.slice(0, 3), launch)
  assert.deepEqual(result[3], {
    id: 'production-gce-c30', url: 'https://c30.relay.onorca.dev', capacityRequests: 6_000,
    region: 'asia-east2', initiallyEnabled: false, connectionHardCap: 3_000,
    connectionUnobservedBound: 60
  })
})

test('checks C30 against its own digest, not the launch cells\' digest', () => {
  const c30Digest = `sha256:${'b'.repeat(64)}`
  const c30 = {
    ...topologyCell(30, 'asia-east2-a'),
    image: `us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@${c30Digest}`
  }
  const launch = [27, 28, 29].map((ordinal) => ({
    id: `production-gce-c${ordinal}`, url: `https://c${ordinal}.relay.onorca.dev`,
    capacityRequests: 6_000, region: 'asia-east2', initiallyEnabled: false,
    connectionHardCap: 3_000, connectionUnobservedBound: 60
  }))
  assert.equal(prepareRelayAsiaDirectorCells({
    currentCells: launch, topology: { 'production-gce-c30': c30 },
    cellIds: 'production-gce-c30', imageDigest: c30Digest
  }).length, 4)
  assert.throws(() => prepareRelayAsiaDirectorCells({
    currentCells: launch, topology: { 'production-gce-c30': c30 },
    cellIds: 'production-gce-c30', imageDigest: digest
  }), /does not match/)
})

test('pins the Asia pool per environment', () => {
  const staging = { ...topologyCell(4, 'asia-east2-a'), database_pool_max: 10 }
  assert.equal(prepareRelayAsiaDirectorCells({
    currentCells: [], topology: { 'staging-gce-c4': staging },
    cellIds: 'staging-gce-c4', imageDigest: digest
  }).length, 1)
  assert.throws(() => prepareRelayAsiaDirectorCells({
    currentCells: [], topology: { 'staging-gce-c4': { ...staging, database_pool_max: 16 } },
    cellIds: 'staging-gce-c4', imageDigest: digest
  }), /does not match/)
  assert.throws(() => prepareRelayAsiaDirectorCells({
    currentCells: [],
    topology: { 'production-gce-c30': { ...topologyCell(30, 'asia-east2-a'), database_pool_max: 10 } },
    cellIds: 'production-gce-c30', imageDigest: digest
  }), /does not match/)
})

test('rejects a mismatching topology state output', () => {
  const wrong = topologyCell(27, 'asia-east2-a')
  wrong.database_pool_max = 20
  assert.throws(() => prepareRelayAsiaDirectorCells({
    currentCells: [], topology: { 'production-gce-c27': wrong },
    cellIds: 'production-gce-c27', imageDigest: digest
  }), /does not match/)
})
