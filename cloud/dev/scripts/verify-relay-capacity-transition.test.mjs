import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseCapacityTransitionArguments,
  verifyCapacityTransition
} from './verify-relay-capacity-transition.mjs'

const imageDigest = `sha256:${'a'.repeat(64)}`
const config = {
  directorOrigin: 'https://relay.example.com',
  cellOrigin: 'https://c3.relay.example.com',
  cellId: 'staging-gce-c3',
  heartbeat: 'fresh',
  admission: 'non-general',
  draining: 'required',
  activity: 'quiescent',
  expectedImageDigests: [imageDigest],
  hardCap: 1_000,
  unobservedBound: 60,
  timeoutMs: 1
}

function response(body) {
  return Response.json(body)
}

function harness({
  heartbeatFresh = true,
  active = 0,
  preAuthConnections = 0,
  inFlightConnections = 0,
  reservedConnectionUnits = 0,
  enforcedConnectionUnits = active,
  activityLeases = active,
  activityRequestUnits = activityLeases,
  reservedRequests = activityRequestUnits,
  restartBlockingActivityLeases = activityLeases,
  restartBlockingActivityRequestUnits = activityRequestUnits,
  restartBlockingReservedRequests = reservedRequests,
  outgoingMigrations = 0,
  incomingMigrations = 0,
  controls = 0,
  splices = 0,
  pendingSplices = 0,
  queuedBytes = 0,
  pendingControlReservations = 0,
  runtimeHardCap = 1_000,
  directorHardCap = 1_000,
  runtimeImageDigest = imageDigest,
  protocol = 2,
  regionalRehomeProtocol = 1,
  legacy = false,
  admission = config.admission,
  draining = config.draining
} = {}) {
  return async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/health') {
      return response({ ok: true, connectionCapacityProtocol: protocol })
    }
    if (parsed.pathname === '/v1/admin/runtime-status') {
      return response({
        role: 'cell',
        cellId: config.cellId,
        cellUrl: config.cellOrigin,
        imageDigest: runtimeImageDigest,
        ...(regionalRehomeProtocol === null ? {} : { regionalRehomeProtocol }),
        draining: draining === 'required',
        connectionCapacity: legacy
          ? null
          : {
              hardCap: runtimeHardCap,
              unobservedBound: 60,
              controlRebindReserve: 100,
              ordinaryConnectionLimit: runtimeHardCap - 100,
              normalAdmissionPause: runtimeHardCap - 160
            },
        runtime: {
          totalConnections: active,
          preAuthConnections,
          controls,
          splices,
          pendingSplices,
          queuedBytes,
          ...(legacy ? {} : {
            inFlightConnections,
            reservedConnectionUnits,
            enforcedConnectionUnits
          })
        }
      })
    }
    return response({
      status: {
        cellId: config.cellId,
        cellUrl: config.cellOrigin,
        admissionState: admission === 'non-general' ? 'migration-only' : admission,
        runtime: { heartbeatFresh, cellUrl: config.cellOrigin },
        assignments: 900,
        activityLeases,
        activityRequestUnits,
        restartBlockingActivityLeases,
        restartBlockingActivityRequestUnits,
        restartBlockingReservedRequests,
        reservedRequests,
        outgoingMigrations,
        incomingMigrations,
        connectionCapacity: {
          hardCap: directorHardCap,
          unobservedBound: 60,
          controlRebindReserve: 100,
          ordinaryConnectionLimit: directorHardCap - 100,
          normalAdmissionPause: directorHardCap - 160,
          observedConnections: 0,
          inFlightConnections: 0,
          reservedConnectionUnits: 0,
          enforcedConnectionUnits: 0,
          pendingControlReservations,
          heartbeatFresh
        }
      }
    })
  }
}

test('parses a paired reviewed capacity', () => {
  assert.deepEqual(
    parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'stale',
      '--admission', 'migration-only',
      '--draining', 'required',
      '--activity', 'restart-safe',
      '--expected-image-digests', imageDigest,
      '--hard-cap', '1000',
      '--unobserved-bound', '60'
    ]),
    {
      ...config,
      heartbeat: 'stale',
      admission: 'migration-only',
      activity: 'restart-safe',
      runtime: 'required',
      expectedImageDigests: [imageDigest],
      timeoutMs: 180_000
    }
  )
})

test('accepts either exact predecessor image without weakening the live state checks', async () => {
  const predecessor = `sha256:${'b'.repeat(64)}`
  const compatible = `sha256:${'c'.repeat(64)}`
  const predecessorConfig = parseCapacityTransitionArguments([
    '--director-origin', 'https://relay.example.com',
    '--cell-origin', 'https://c3.relay.example.com',
    '--cell-id', 'staging-gce-c3',
    '--heartbeat', 'fresh',
    '--admission', 'general',
    '--draining', 'forbidden',
    '--activity', 'allowed',
    '--expected-image-digests', `${predecessor},${compatible}`,
    '--hard-cap', '600',
    '--unobserved-bound', '60'
  ])
  assert.deepEqual(predecessorConfig.expectedImageDigests, [predecessor, compatible])
  assert.deepEqual(
    {
      heartbeat: predecessorConfig.heartbeat,
      admission: predecessorConfig.admission,
      draining: predecessorConfig.draining,
      hardCap: predecessorConfig.hardCap,
      unobservedBound: predecessorConfig.unobservedBound
    },
    {
      heartbeat: 'fresh',
      admission: 'general',
      draining: 'forbidden',
      hardCap: 600,
      unobservedBound: 60
    }
  )
  const liveState = {
    runtimeHardCap: 600,
    directorHardCap: 600,
    runtimeImageDigest: compatible,
    admission: 'general',
    draining: 'forbidden'
  }
  assert.equal(
    (await verifyCapacityTransition(predecessorConfig, {
      fetch: harness(liveState),
      token: 'masked-token'
    })).imageDigest,
    compatible
  )
  await assert.rejects(
    verifyCapacityTransition(predecessorConfig, {
      fetch: harness({
        ...liveState,
        runtimeImageDigest: `sha256:${'d'.repeat(64)}`
      }),
      token: 'masked-token'
    }),
    /runtime does not match the cell/
  )
})

test('requires the exact regional rehome protocol when requested', async () => {
  const rehomeConfig = {
    ...config,
    regionalRehomeProtocol: 1
  }
  await verifyCapacityTransition(rehomeConfig, {
    token: 'token',
    fetch: harness({ regionalRehomeProtocol: 1 })
  })
  await assert.rejects(
    verifyCapacityTransition(rehomeConfig, {
      token: 'token',
      fetch: harness({ regionalRehomeProtocol: 0 }),
      now: () => 1,
      wait: async () => undefined
    }),
    /runtime does not match/
  )
  assert.equal(
    parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'fresh',
      '--admission', 'general',
      '--draining', 'forbidden',
      '--activity', 'allowed',
      '--regional-rehome-protocol', '1'
    ]).regionalRehomeProtocol,
    1
  )
})

test('binds an absent rehome protocol to 0 for legacy pre-rehome images', async () => {
  // A rolled-back cell runs an image that omits the field entirely; the
  // documented contract binds absence to protocol 0.
  await verifyCapacityTransition(
    { ...config, regionalRehomeProtocol: 0 },
    { token: 'token', fetch: harness({ regionalRehomeProtocol: null }) }
  )
  await verifyCapacityTransition(
    { ...config, regionalRehomeProtocol: 0 },
    { token: 'token', fetch: harness({ regionalRehomeProtocol: 0 }) }
  )
  await assert.rejects(
    verifyCapacityTransition(
      { ...config, regionalRehomeProtocol: 1 },
      {
        token: 'token',
        fetch: harness({ regionalRehomeProtocol: null }),
        now: () => 1,
        wait: async () => undefined
      }
    ),
    /runtime does not match/
  )
})

test('restart-safe mode requires the exact isolated drain state', () => {
  assert.throws(
    () => parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'either',
      '--admission', 'general',
      '--draining', 'required',
      '--activity', 'restart-safe'
    ]),
    /requires migration-only admission and draining/
  )
})

test('offline rollback requires two stale zero-durable-activity samples', async () => {
  const offlineConfig = {
    ...config,
    heartbeat: 'stale',
    admission: 'migration-only',
    draining: 'either',
    activity: 'restart-safe',
    runtime: 'unavailable',
    expectedImageDigests: [],
    hardCap: undefined,
    unobservedBound: undefined,
    timeoutMs: 10_000
  }
  const base = harness({
    heartbeatFresh: false,
    admission: 'migration-only',
    draining: 'forbidden',
    activityLeases: 0,
    activityRequestUnits: 0,
    reservedRequests: 0,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: -1
  })
  let runtimeReads = 0
  let directorReads = 0
  let now = 0
  const result = await verifyCapacityTransition(offlineConfig, {
    fetch: async (url, options) => {
      const pathname = new URL(url).pathname
      if (pathname === '/v1/admin/runtime-status') {
        runtimeReads += 1
        return Response.json({ error: 'backend_unavailable' }, { status: 503 })
      }
      if (pathname === '/v1/admin/cell-status') directorReads += 1
      return await base(url, options)
    },
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })
  assert.equal(result.cellId, config.cellId)
  assert.equal(result.hardCap, null)
  assert.equal(result.restartBlockingReservedRequests, -1)
  assert.equal(runtimeReads, 2)
  assert.equal(directorReads, 2)
})

test('offline rollback rejects a reachable cell or durable work', async () => {
  const offlineConfig = {
    ...config,
    heartbeat: 'stale',
    admission: 'migration-only',
    draining: 'either',
    activity: 'restart-safe',
    runtime: 'unavailable',
    expectedImageDigests: [],
    hardCap: undefined,
    unobservedBound: undefined,
    timeoutMs: 0
  }
  await assert.rejects(
    verifyCapacityTransition(offlineConfig, {
      fetch: harness({ heartbeatFresh: false, admission: 'migration-only' }),
      token: 'masked-token'
    }),
    /timed out/
  )
  const active = harness({
    heartbeatFresh: false,
    admission: 'migration-only',
    activityLeases: 1
  })
  await assert.rejects(
    verifyCapacityTransition(offlineConfig, {
      fetch: async (url, options) =>
        new URL(url).pathname === '/v1/admin/runtime-status'
          ? Response.json({ error: 'backend_unavailable' }, { status: 503 })
          : await active(url, options),
      token: 'masked-token'
    }),
    /timed out/
  )
  await assert.rejects(
    verifyCapacityTransition(offlineConfig, {
      fetch: async (url, options) => {
        if (new URL(url).pathname === '/v1/admin/runtime-status') {
          return Response.json({ error: 'backend_unavailable' }, { status: 503 })
        }
        const result = await active(url, options)
        if (new URL(url).pathname !== '/v1/admin/cell-status') return result
        const body = await result.json()
        body.status.cellId = 'production-gce-other'
        return response(body)
      },
      token: 'masked-token'
    }),
    /does not match the cell/
  )
})

test('offline rollback arguments cannot claim live capacity', () => {
  assert.throws(
    () => parseCapacityTransitionArguments([
      '--director-origin', 'https://relay.example.com',
      '--cell-origin', 'https://c3.relay.example.com',
      '--cell-id', 'staging-gce-c3',
      '--heartbeat', 'stale',
      '--admission', 'migration-only',
      '--draining', 'either',
      '--activity', 'restart-safe',
      '--runtime', 'unavailable',
      '--hard-cap', '600',
      '--unobserved-bound', '60'
    ]),
    /cannot prove live capacity/
  )
})

test('accepts a quiescent matching cell without exposing assignments', async () => {
  assert.deepEqual(
    await verifyCapacityTransition(config, {
      fetch: harness(),
      token: 'masked-token'
    }),
    {
      cellId: config.cellId,
      admissionState: 'migration-only',
      assignments: 900,
      hardCap: 1_000,
      unobservedBound: 60,
      heartbeatFresh: true,
      imageDigest
    }
  )
})

test('migration-only admission rejects the irreversible existing-only state', async () => {
  const migrationConfig = { ...config, admission: 'migration-only' }
  await verifyCapacityTransition(migrationConfig, {
    fetch: harness({ admission: 'migration-only' }),
    token: 'masked-token'
  })
  await assert.rejects(
    verifyCapacityTransition(migrationConfig, {
      fetch: harness({ admission: 'existing-only' }),
      token: 'masked-token'
    }),
    /admission does not match/
  )
})

test('requires the exact runtime image and both cell origins', async () => {
  await assert.rejects(
    verifyCapacityTransition(config, {
      fetch: harness({ runtimeImageDigest: `sha256:${'b'.repeat(64)}` }),
      token: 'masked-token'
    }),
    /runtime does not match the cell/
  )
  const base = harness()
  for (const location of ['runtime', 'director']) {
    await assert.rejects(
      verifyCapacityTransition(config, {
        fetch: async (url, options) => {
          const result = await base(url, options)
          const path = new URL(url).pathname
          if (
            (location === 'runtime' && path !== '/v1/admin/runtime-status') ||
            (location === 'director' && path !== '/v1/admin/cell-status')
          ) return result
          const body = await result.json()
          if (location === 'runtime') body.cellUrl = 'https://other.example.com'
          else body.status.cellUrl = 'https://other.example.com'
          return response(body)
        },
        token: 'masked-token'
      }),
      /does not match the cell/
    )
  }
})

test('accepts a quiescent legacy runtime before its first cap transition', async () => {
  assert.equal(
    (
      await verifyCapacityTransition(
        { ...config, hardCap: undefined, unobservedBound: undefined, heartbeat: 'either' },
        { fetch: harness({ legacy: true }), token: 'masked-token' }
      )
    ).cellId,
    config.cellId
  )
})

test('uses the legacy runtime heartbeat when capacity telemetry is not registered', async () => {
  const result = await verifyCapacityTransition(
    {
      ...config,
      hardCap: undefined,
      unobservedBound: undefined,
      heartbeat: 'fresh',
      draining: 'forbidden',
      activity: 'allowed'
    },
    { fetch: harness({ legacy: true, draining: 'forbidden' }), token: 'masked-token' }
  )
  assert.equal(result.heartbeatFresh, true)
})

test('rejects old directors and active cells', async () => {
  await assert.rejects(
    verifyCapacityTransition(config, { fetch: harness({ protocol: 1 }), token: 'masked' }),
    /not capacity-protocol compatible/
  )
  let now = 0
  await assert.rejects(
    verifyCapacityTransition(config, {
      fetch: harness({ active: 1 }),
      token: 'masked',
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      }
    }),
    /timed out/
  )
})

test('accepts active controls only when the transition explicitly allows them', async () => {
  const activeConfig = {
    ...config,
    admission: 'general',
    draining: 'forbidden',
    activity: 'allowed'
  }
  const result = await verifyCapacityTransition(activeConfig, {
    fetch: harness({ active: 900, admission: 'general', draining: 'forbidden' }),
    token: 'masked'
  })
  assert.equal(result.admissionState, 'general')
})

test('accepts only rejected reconnect traffic at the restart gate', async () => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 10_000
  }
  const reconnecting = harness({
    active: 10,
    activityLeases: 839,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: 0,
    pendingControlReservations: 839
  })
  let now = 0
  let runtimeReads = 0
  const fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status') runtimeReads += 1
    return await reconnecting(url, options)
  }
  assert.equal((await verifyCapacityTransition(restartConfig, {
    fetch,
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })).cellId, config.cellId)
  assert.equal(runtimeReads, 2)
  await assert.rejects(
    verifyCapacityTransition({ ...config, timeoutMs: 0 }, {
      fetch: reconnecting,
      token: 'masked-token'
    }),
    /timed out/
  )
})

test('restart-safe settling resets after data-plane admission appears', async () => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 20_000
  }
  const safe = harness({ active: 1, activityLeases: 0 })
  const unsafe = harness({ active: 1, activityLeases: 0, preAuthConnections: 1 })
  let runtimeReads = 0
  let now = 0
  const result = await verifyCapacityTransition(restartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname !== '/v1/admin/runtime-status') {
        return await safe(url, options)
      }
      runtimeReads += 1
      return await (runtimeReads === 2 ? unsafe : safe)(url, options)
    },
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })
  assert.equal(result.cellId, config.cellId)
  assert.equal(runtimeReads, 4)
})

test('restart-safe settling resets after director activity appears', async () => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 20_000
  }
  const safe = harness({
    activityLeases: 839,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: 0
  })
  const unsafe = harness({
    activityLeases: 840,
    restartBlockingActivityLeases: 1,
    restartBlockingActivityRequestUnits: 1,
    restartBlockingReservedRequests: 1
  })
  let directorReads = 0
  let runtimeReads = 0
  let now = 0
  const result = await verifyCapacityTransition(restartConfig, {
    fetch: async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status') runtimeReads += 1
      if (new URL(url).pathname !== '/v1/admin/cell-status') {
        return await safe(url, options)
      }
      directorReads += 1
      return await (directorReads === 2 ? unsafe : safe)(url, options)
    },
    token: 'masked-token',
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds
    }
  })
  assert.equal(result.cellId, config.cellId)
  assert.equal(runtimeReads, 4)
})

test('restart gate rejects malformed restart aggregates', async (t) => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 0
  }
  for (const field of [
    'restartBlockingActivityLeases',
    'restartBlockingActivityRequestUnits'
  ]) {
    for (const value of [undefined, -1]) {
      await t.test(`${field} ${value === undefined ? 'missing' : 'negative'}`, async () => {
        const base = harness({ [field]: value })
        const fetch = value === undefined
          ? async (url, options) => {
              const result = await base(url, options)
              if (new URL(url).pathname !== '/v1/admin/cell-status') return result
              const body = await result.json()
              delete body.status[field]
              return response(body)
            }
          : base
        await assert.rejects(
          verifyCapacityTransition(restartConfig, {
            fetch,
            token: 'masked-token'
          }),
          /is invalid/
        )
      })
    }
  }
  for (const value of [undefined, null, '0', false]) {
    await t.test(`restartBlockingReservedRequests ${String(value)}`, async () => {
      const base = harness({
        preAuthConnections: 1,
        restartBlockingActivityLeases: 1,
        restartBlockingReservedRequests: value
      })
      await assert.rejects(
        verifyCapacityTransition(restartConfig, {
          fetch: async (url, options) => {
            const result = await base(url, options)
            if (
              value !== undefined ||
              new URL(url).pathname !== '/v1/admin/cell-status'
            ) return result
            const body = await result.json()
            delete body.status.restartBlockingReservedRequests
            return response(body)
          },
          token: 'masked-token'
        }),
        /is invalid/
      )
    })
  }
})

test('offline rollback validates restart reservation accounting before other blockers', async (t) => {
  const offlineConfig = {
    ...config,
    heartbeat: 'stale',
    admission: 'migration-only',
    draining: 'either',
    activity: 'restart-safe',
    runtime: 'unavailable',
    expectedImageDigests: [],
    hardCap: undefined,
    unobservedBound: undefined,
    timeoutMs: 0
  }
  for (const value of [undefined, null, '0', false]) {
    await t.test(String(value), async () => {
      const base = harness({
        heartbeatFresh: false,
        activityLeases: 1,
        restartBlockingReservedRequests: value
      })
      await assert.rejects(
        verifyCapacityTransition(offlineConfig, {
          fetch: async (url, options) => {
            const pathname = new URL(url).pathname
            if (pathname === '/v1/admin/runtime-status') {
              return Response.json({ error: 'backend_unavailable' }, { status: 503 })
            }
            const result = await base(url, options)
            if (value !== undefined || pathname !== '/v1/admin/cell-status') return result
            const body = await result.json()
            delete body.status.restartBlockingReservedRequests
            return response(body)
          },
          token: 'masked-token'
        }),
        /is invalid/
      )
    })
  }
})

test('negative restart reservation accounting is safe and remains observable', async () => {
  const result = await verifyCapacityTransition(
    {
      ...config,
      admission: 'migration-only',
      activity: 'restart-safe',
      timeoutMs: 10_000
    },
    {
      fetch: harness({ restartBlockingReservedRequests: -1 }),
      token: 'masked-token',
      now: () => 0,
      wait: async () => undefined
    }
  )
  assert.equal(result.restartBlockingReservedRequests, -1)
})

test('negative restart reservation accounting cannot mask real work', async () => {
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        activity: 'restart-safe',
        timeoutMs: 0
      },
      {
        fetch: harness({
          restartBlockingActivityLeases: 1,
          restartBlockingReservedRequests: -1
        }),
        token: 'masked-token'
      }
    ),
    /"restartBlockingReservedRequests":-1/
  )
})

test('restart gate rejects live or durable cell work', async (t) => {
  const restartConfig = {
    ...config,
    admission: 'migration-only',
    activity: 'restart-safe',
    timeoutMs: 0
  }
  const unsafeStates = [
    ['control', { active: 1, activityLeases: 0, controls: 1 }],
    ['splice', { active: 1, activityLeases: 0, splices: 1 }],
    ['pending splice', { active: 1, activityLeases: 0, pendingSplices: 1 }],
    ['queued data', { active: 1, activityLeases: 0, queuedBytes: 1 }],
    ['pre-auth connection', { active: 1, activityLeases: 0, preAuthConnections: 1 }],
    ['in-flight connection', {
      activityLeases: 0,
      inFlightConnections: 1,
      enforcedConnectionUnits: 1
    }],
    ['reserved data unit', {
      active: 1,
      activityLeases: 0,
      reservedConnectionUnits: 1,
      enforcedConnectionUnits: 2
    }],
    ['activity lease', { activityLeases: 1 }],
    ['misaccounted pending control lease', {
      activityLeases: 1,
      activityRequestUnits: 2,
      reservedRequests: 2,
      restartBlockingActivityLeases: 0,
      restartBlockingActivityRequestUnits: 1,
      restartBlockingReservedRequests: 1
    }],
    ['cell reservation', { reservedRequests: 1 }],
    ['outgoing migration', { outgoingMigrations: 1 }],
    ['incoming migration', { incomingMigrations: 1 }]
  ]
  for (const [name, state] of unsafeStates) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyCapacityTransition(restartConfig, {
          fetch: harness(state),
          token: 'masked-token'
        }),
        /timed out/
      )
    })
  }
})

test('restart timeout reports only aggregate blockers', async () => {
  const base = harness({
    controls: 2,
    restartBlockingActivityLeases: 3,
    restartBlockingActivityRequestUnits: 4,
    restartBlockingReservedRequests: 5,
    incomingMigrations: 6
  })
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        draining: 'required',
        activity: 'restart-safe',
        timeoutMs: 0
      },
      { fetch: base, token: 'masked-token' }
    ),
    (error) => {
      assert.match(error.message, /"controls":2/)
      assert.match(error.message, /"restartBlockingActivityLeases":3/)
      assert.match(error.message, /"incomingMigrations":6/)
      assert.doesNotMatch(error.message, /user|host|secret|token/i)
      return true
    }
  )
})

test('restart timeout reports one of two safe settling samples', async () => {
  const base = harness()
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        draining: 'required',
        activity: 'restart-safe',
        timeoutMs: 0
      },
      { fetch: base, token: 'masked-token' }
    ),
    (error) => {
      assert.match(error.message, /"restartSafeSamples":1/)
      assert.match(error.message, /"requiredRestartSafeSamples":2/)
      return true
    }
  )
})

test('quiescent timeout reports connection and capacity aggregates', async () => {
  const base = harness({
    active: 2,
    enforcedConnectionUnits: 3,
    activityLeases: 0,
    activityRequestUnits: 0,
    reservedRequests: 0,
    restartBlockingActivityLeases: 0,
    restartBlockingActivityRequestUnits: 0,
    restartBlockingReservedRequests: 0,
    pendingControlReservations: 4,
    heartbeatFresh: false
  })
  await assert.rejects(
    verifyCapacityTransition({ ...config, timeoutMs: 0 }, { fetch: base, token: 'masked-token' }),
    (error) => {
      assert.match(error.message, /"totalConnections":2/)
      assert.match(error.message, /"enforcedConnectionUnits":3/)
      assert.match(error.message, /"pendingControlReservations":4/)
      assert.match(error.message, /"heartbeatFresh":false/)
      return true
    }
  )
})

test('timeout distinguishes runtime and director capacity views', async () => {
  const base = harness({ runtimeHardCap: 999 })
  await assert.rejects(
    verifyCapacityTransition({ ...config, timeoutMs: 0 }, { fetch: base, token: 'masked-token' }),
    (error) => {
      assert.match(error.message, /"runtimeCapacity":\{"hardCap":999/)
      assert.match(error.message, /"directorCapacity":\{"hardCap":1000/)
      return true
    }
  )
})

test('offline timeout reports every durable activity aggregate', async () => {
  const base = harness({
    activityLeases: 1,
    activityRequestUnits: 2,
    reservedRequests: 3,
    pendingControlReservations: 4,
    heartbeatFresh: false
  })
  await assert.rejects(
    verifyCapacityTransition(
      {
        ...config,
        admission: 'migration-only',
        draining: 'either',
        activity: 'restart-safe',
        heartbeat: 'stale',
        runtime: 'unavailable',
        hardCap: undefined,
        unobservedBound: undefined,
        timeoutMs: 0
      },
      {
        fetch: async (url, options) =>
          new URL(url).pathname === '/v1/admin/runtime-status'
            ? Response.json({ error: 'backend_unavailable' }, { status: 503 })
            : await base(url, options),
        token: 'masked-token'
      }
    ),
    (error) => {
      assert.match(error.message, /"activityLeases":1/)
      assert.match(error.message, /"activityRequestUnits":2/)
      assert.match(error.message, /"reservedRequests":3/)
      assert.match(error.message, /"pendingControlReservations":4/)
      return true
    }
  )
})

test('waits for a drained runtime to become quiescent', async () => {
  let runtimeReads = 0
  const base = harness()
  const fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status' && runtimeReads++ === 0) {
      return Response.json({
        role: 'cell',
        cellId: config.cellId,
        cellUrl: config.cellOrigin,
        imageDigest,
        draining: true,
        connectionCapacity: {
          hardCap: 1_000,
          unobservedBound: 60,
          controlRebindReserve: 100,
          ordinaryConnectionLimit: 900,
          normalAdmissionPause: 840
        },
        runtime: { totalConnections: 1, preAuthConnections: 0, enforcedConnectionUnits: 1 }
      })
    }
    return await base(url, options)
  }
  let now = 0
  const result = await verifyCapacityTransition(
    { ...config, timeoutMs: 10_000 },
    {
      fetch,
      token: 'masked',
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      }
    }
  )
  assert.equal(result.cellId, config.cellId)
  assert.equal(runtimeReads, 2)
})

test('waits for transient cell routing after a replacement becomes stable', async () => {
  for (const status of [502, 503, 504]) {
    let runtimeReads = 0
    let unavailableResponse
    const base = harness()
    const fetch = async (url, options) => {
      if (new URL(url).pathname === '/v1/admin/runtime-status' && runtimeReads++ === 0) {
        unavailableResponse = Response.json({ error: 'backend_unavailable' }, { status })
        return unavailableResponse
      }
      return await base(url, options)
    }
    let now = 0
    const result = await verifyCapacityTransition(
      { ...config, timeoutMs: 10_000 },
      {
        fetch,
        token: 'masked',
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        }
      }
    )
    assert.equal(result.cellId, config.cellId)
    assert.equal(runtimeReads, 2)
    assert.equal(unavailableResponse.bodyUsed, true)
  }
})

test('persistent cell unavailability fails closed at the deadline', async () => {
  let runtimeReads = 0
  let directorStatusReads = 0
  let waits = 0
  let now = 0
  const base = harness()
  await assert.rejects(
    verifyCapacityTransition(
      { ...config, timeoutMs: 10_000 },
      {
        fetch: async (url, options) => {
          const pathname = new URL(url).pathname
          if (pathname === '/v1/admin/runtime-status') {
            runtimeReads += 1
            return Response.json({ error: 'backend_unavailable' }, { status: 503 })
          }
          if (pathname === '/v1/admin/cell-status') directorStatusReads += 1
          return await base(url, options)
        },
        token: 'masked',
        now: () => now,
        wait: async (milliseconds) => {
          waits += 1
          now += milliseconds
        }
      }
    ),
    /capacity transition verification timed out: \{"runtimeAvailable":false\}/
  )
  assert.equal(runtimeReads, 3)
  assert.equal(directorStatusReads, 0)
  assert.equal(waits, 2)
})

test('general-or-migration-only admits both recovery states and nothing else', async () => {
  for (const [admission, accepted] of [
    ['general', true],
    ['migration-only', true],
    ['existing-only', false]
  ]) {
    const attempt = verifyCapacityTransition(
      {
        ...config,
        admission: 'general-or-migration-only',
        draining: 'either',
        activity: 'allowed'
      },
      { fetch: harness({ admission, draining: 'either' }), token: 'masked' }
    )
    if (accepted) {
      await attempt
    } else {
      await assert.rejects(attempt, /admission does not match/)
    }
  }
})

test('does not retry a rejected cell admin token', async () => {
  let waits = 0
  const base = harness()
  await assert.rejects(
    verifyCapacityTransition(config, {
      fetch: async (url, options) =>
        new URL(url).pathname === '/v1/admin/runtime-status'
          ? Response.json({ error: 'invalid_token' }, { status: 401 })
          : await base(url, options),
      token: 'masked',
      wait: async () => {
        waits += 1
      }
    }),
    /cell runtime status returned 401/
  )
  assert.equal(waits, 0)
})
