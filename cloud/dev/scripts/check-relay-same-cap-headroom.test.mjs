import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkSameCapHeadroom,
  main,
  parseHeadroomArguments
} from './check-relay-same-cap-headroom.mjs'

const config = {
  directorOrigin: 'https://relay.example.com',
  cellOrigin: 'https://c28.relay.example.com',
  cellId: 'production-gce-c28',
  generalCells: ['production-gce-c28', 'production-gce-c29', 'production-gce-asia-c1']
}

function cell({
  region = 'us-central1',
  pause = 840,
  observed = 0,
  enforced = observed,
  pending = 0,
  ...rest
} = {}) {
  return {
    enabled: true,
    admissionState: 'general',
    region,
    connectionCapacity: {
      normalAdmissionPause: pause,
      observedConnections: observed,
      enforcedConnectionUnits: enforced,
      pendingControlReservations: pending,
      heartbeatFresh: true
    },
    ...rest
  }
}

function harness({ controls = 500, cells = {} } = {}) {
  const statuses = {
    'production-gce-c28': cell({ observed: 800 }),
    'production-gce-c29': cell({ observed: 340 }),
    'production-gce-asia-c1': cell({ region: 'asia-east2', pause: 2_840, observed: 2_640 }),
    ...cells
  }
  return async (url, options) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status') {
      return Response.json({ role: 'cell', cellId: config.cellId, runtime: { controls } })
    }
    const { cellId } = JSON.parse(options.body)
    return Response.json({ v: 1, status: { cellId, ...statuses[cellId] } })
  }
}

const run = async (fetch) =>
  await checkSameCapHeadroom(config, { fetch, token: 'masked-token', wait: async () => {} })

test('counts free general-cell slots by region and excludes the target', async () => {
  const result = await run(harness({ controls: 560 }))
  assert.deepEqual(
    { ...result, cells: undefined },
    {
      cellId: config.cellId,
      region: 'us-central1',
      targetHosts: 560,
      freeSlots: 700,
      sameRegionFreeSlots: 500,
      otherRegionFreeSlots: 200,
      allowedHosts: 560,
      sufficient: true,
      cells: undefined
    }
  )
  assert.deepEqual(result.cells.map((entry) => entry.cellId), [
    'production-gce-c29',
    'production-gce-asia-c1'
  ])
})

test('free slots subtract the larger of observed and enforced use plus reservations', async () => {
  for (const [state, free] of [
    [{ observed: 340, enforced: 400 }, 640],
    [{ observed: 400, enforced: 340 }, 640],
    [{ observed: 340, pending: 60 }, 640],
    [{ observed: 800, pending: 60 }, 200]
  ]) {
    const result = await run(harness({ cells: { 'production-gce-c29': cell(state) } }))
    assert.equal(result.freeSlots, free)
  }
})

test('rejects malformed capacity counts', async () => {
  await assert.rejects(
    run(harness({
      cells: { 'production-gce-c29': cell({ pending: null }) }
    })),
    /pending control reservations is invalid/
  )
})

test('refuses a cell whose hosts exceed 80% of the free slots', async () => {
  const result = await run(harness({ controls: 561 }))
  assert.equal(result.sufficient, false)
})

test('a stale, full, or non-general cell offers no slots', async () => {
  for (const blocked of [
    cell({
      connectionCapacity: {
        normalAdmissionPause: 840,
        observedConnections: 0,
        enforcedConnectionUnits: 0,
        pendingControlReservations: 0,
        heartbeatFresh: false
      }
    }),
    cell({ connectionCapacity: null }),
    cell({ admissionState: 'migration-only' }),
    cell({ enabled: false }),
    cell({ observed: 900 })
  ]) {
    const result = await run(harness({ cells: { 'production-gce-c29': blocked } }))
    assert.equal(result.freeSlots, 200)
    assert.equal(result.sufficient, false)
  }
})

test('no general cells means no headroom', async () => {
  const result = await checkSameCapHeadroom(
    { ...config, generalCells: [] },
    { fetch: harness({ controls: 1 }), token: 'masked-token', wait: async () => {} }
  )
  assert.equal(result.freeSlots, 0)
  assert.equal(result.sufficient, false)
})

test('rejects a runtime or director answer for another cell', async () => {
  const base = harness()
  await assert.rejects(
    run(async (url, options) =>
      new URL(url).pathname === '/v1/admin/runtime-status'
        ? Response.json({ role: 'cell', cellId: 'production-gce-c1', runtime: { controls: 1 } })
        : await base(url, options)),
    /runtime status does not match/
  )
  await assert.rejects(
    run(async (url, options) =>
      new URL(url).pathname === '/v1/admin/cell-status'
        ? Response.json({ v: 1, status: { cellId: 'production-gce-c1' } })
        : await base(url, options)),
    /director status does not match/
  )
})

test('parses the general cell list, including none', () => {
  const base = [
    '--director-origin', 'https://relay.example.com',
    '--cell-origin', 'https://c28.relay.example.com',
    '--cell-id', 'production-gce-c28'
  ]
  assert.deepEqual(
    parseHeadroomArguments([...base, '--general-cells', 'a-c1,b-c2']).generalCells,
    ['a-c1', 'b-c2']
  )
  assert.deepEqual(parseHeadroomArguments([...base, '--general-cells', 'none']).generalCells, [])
  assert.throws(() => parseHeadroomArguments([...base, '--general-cells', 'a,a']), /invalid/)
  assert.throws(() => parseHeadroomArguments(base), /missing --general-cells/)
})

test('main prints the numbers and fails on insufficient headroom', async (t) => {
  const writes = []
  t.mock.method(process.stdout, 'write', (text) => writes.push(text))
  t.mock.method(globalThis, 'fetch', harness({ controls: 700 }))
  process.env.ORCA_RELAY_ADMIN_ID_TOKEN = 'masked-token'
  t.after(() => {
    delete process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  })
  await assert.rejects(
    main([
      '--director-origin', config.directorOrigin,
      '--cell-origin', config.cellOrigin,
      '--cell-id', config.cellId,
      '--general-cells', config.generalCells.join(',')
    ]),
    /700 hosts on production-gce-c28 exceed 80% of 700 free general-cell slots/
  )
  const line = JSON.parse(writes.join(''))
  assert.equal(line.event, 'relay_same_cap_headroom')
  assert.equal(line.allowedHosts, 560)
})
