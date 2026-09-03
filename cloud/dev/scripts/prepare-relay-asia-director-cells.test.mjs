import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareRelayAsiaDirectorCells } from './prepare-relay-asia-director-cells.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const topologyCell = (ordinal, zone) => ({
  origin: `https://c${ordinal}.relay.onorca.dev`, region: 'asia-east2', zone,
  capacity_requests: 6_000, database_pool_max: 10,
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

test('rejects a mismatching topology state output', () => {
  const wrong = topologyCell(27, 'asia-east2-a')
  wrong.database_pool_max = 20
  assert.throws(() => prepareRelayAsiaDirectorCells({
    currentCells: [], topology: { 'production-gce-c27': wrong },
    cellIds: 'production-gce-c27', imageDigest: digest
  }), /does not match/)
})
