import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertRelayLoadDirectorCapacityToken,
  waitForRelayLoadDirectorCapacity,
  waitForRelayLoadRequestUnits
} from './relay-load-director-capacity-gate.mjs'

function token(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`
}

const config = {
  directorOrigin: 'https://relay-staging.example.com',
  adminToken: token({
    aud: 'https://relay-staging.example.com/v1/admin/drain',
    email: 'capacity@example.com',
    email_verified: true,
    exp: 4_000_000_000
  }),
  cellId: 'staging-gce-c3',
  hardCap: 1_000,
  unobservedBound: 60,
  requiredConnections: 840
}

function status(lastHeartbeatAt, overrides = {}) {
  return {
    cellId: config.cellId,
    admissionState: 'general',
    runtime: { ready: true, heartbeatFresh: true, lastHeartbeatAt, observedRequests: 0 },
    connectionCapacity: {
      hardCap: 1_000,
      unobservedBound: 60,
      normalAdmissionPause: 840,
      observedConnections: 840,
      enforcedConnectionUnits: 840,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      pendingControlReservations: 0,
      heartbeatFresh: true,
      ...overrides
    }
  }
}

function response(value, responseStatus = 200) {
  return {
    ok: responseStatus >= 200 && responseStatus < 300,
    status: responseStatus,
    json: async () => value,
    arrayBuffer: async () => new ArrayBuffer(0)
  }
}

test('requires two advancing exact director capacity heartbeats', async () => {
  const heartbeats = [101, 116, 131]
  let calls = 0
  const result = await waitForRelayLoadDirectorCapacity(config, {
    fetch: async () => response({ status: status(heartbeats[calls++]) }),
    delay: async () => undefined
  })
  assert.equal(calls, 3)
  assert.deepEqual(result, { heartbeatAt: 131 })
})

test('resets after a newer heartbeat undercounts recovered controls', async () => {
  const samples = [
    status(101),
    status(116),
    status(131, { observedConnections: 839 }),
    status(146),
    status(161)
  ]
  let calls = 0
  await waitForRelayLoadDirectorCapacity(config, {
    fetch: async () => response({ status: samples[calls++] }),
    delay: async () => undefined
  })
  assert.equal(calls, 5)
})

test('fails closed when exact advancing telemetry never converges', async () => {
  let elapsed = 0
  await assert.rejects(
    waitForRelayLoadDirectorCapacity(config, {
      fetch: async () => response({ status: status(101) }),
      delay: async (milliseconds) => {
        elapsed += milliseconds
      },
      now: () => elapsed,
      timeoutMs: 2_000,
      pollMs: 1_000
    }),
    /did not converge/
  )
})

test('rejects an unauthorized capacity identity without retrying', async () => {
  let calls = 0
  await assert.rejects(
    waitForRelayLoadDirectorCapacity(config, {
      fetch: async () => {
        calls++
        return response({}, 401)
      },
      delay: async () => undefined
    }),
    /identity was rejected/
  )
  assert.equal(calls, 1)
})

test('binds the admin token to the canonical director audience', async () => {
  await assert.rejects(
    waitForRelayLoadDirectorCapacity(
      {
        ...config,
        directorOrigin: 'https://relay-staging.example.com/path'
      },
      { fetch: async () => response({ status: status(101) }), now: () => 0 }
    ),
    /canonical HTTPS/
  )
  await assert.rejects(
    waitForRelayLoadDirectorCapacity(
      {
        ...config,
        adminToken: token({
          aud: 'https://other.example.com/v1/admin/drain',
          email: 'capacity@example.com',
          email_verified: true,
          exp: 4_000_000_000
        })
      },
      { fetch: async () => response({ status: status(101) }), now: () => 0 }
    ),
    /not bound/
  )
})

test('rejects a missing or malformed admin token during startup preflight', () => {
  assert.throws(
    () => assertRelayLoadDirectorCapacityToken({ ...config, adminToken: undefined }, () => 0),
    /unavailable/
  )
  assert.throws(
    () => assertRelayLoadDirectorCapacityToken({ ...config, adminToken: 'not-a-jwt' }, () => 0),
    /invalid/
  )
  assert.throws(
    () =>
      assertRelayLoadDirectorCapacityToken(
        {
          ...config,
          adminToken: token({
            aud: 'https://relay-staging.example.com/v1/admin/drain',
            exp: 4_000_000_000
          })
        },
        () => 0
      ),
    /not bound/
  )
})

test('supports one newer exact post-probe heartbeat', async () => {
  const heartbeats = [146, 161]
  let calls = 0
  const result = await waitForRelayLoadDirectorCapacity(
    { ...config, requiredSamples: 1 },
    {
      fetch: async () => response({ status: status(heartbeats[calls++]) }),
      delay: async () => undefined,
      now: () => 0
    }
  )
  assert.equal(calls, 2)
  assert.deepEqual(result, { heartbeatAt: 161 })
})

test('requires consecutive exact request-unit accounting samples', async () => {
  const requestConfig = {
    ...config,
    capacityRequests: 6_000,
    expectedRequestUnits: 6_000,
    expectedActivityLeases: 6_000
  }
  const samples = [5_999, 6_000, 6_000]
  let calls = 0
  await waitForRelayLoadRequestUnits(requestConfig, {
    fetch: async () => response({
      status: {
        ...status(100),
        runtime: {
          ...status(100).runtime,
          observedRequests: samples[calls]
        },
        capacityRequests: 6_000,
        reservedRequests: samples[calls],
        activityRequestUnits: samples[calls],
        activityLeases: samples[calls++]
      }
    }),
    delay: async () => undefined,
    now: () => 0
  })
  assert.equal(calls, 3)
})

test('requires the cell runtime to observe every request unit', async () => {
  let elapsed = 0
  await assert.rejects(waitForRelayLoadRequestUnits({
    ...config,
    capacityRequests: 6_000,
    expectedRequestUnits: 6_000,
    expectedActivityLeases: 6_000,
    timeoutMs: 1_000
  }, {
    fetch: async () => response({
      status: {
        ...status(100),
        runtime: { ...status(100).runtime, observedRequests: 5_999 },
        capacityRequests: 6_000,
        reservedRequests: 6_000,
        activityRequestUnits: 6_000,
        activityLeases: 6_000
      }
    }),
    delay: async (milliseconds) => { elapsed += milliseconds },
    now: () => elapsed,
    pollMs: 1_000
  }), /did not converge/)
})

test('fails closed when request-unit accounting does not clean up', async () => {
  let elapsed = 0
  await assert.rejects(waitForRelayLoadRequestUnits({
    ...config,
    capacityRequests: 6_000,
    expectedRequestUnits: 0,
    expectedActivityLeases: 0,
    timeoutMs: 2_000
  }, {
    fetch: async () => response({
      status: {
        ...status(100),
        runtime: { ...status(100).runtime, observedRequests: 1 },
        capacityRequests: 6_000,
        reservedRequests: 1,
        activityRequestUnits: 1,
        activityLeases: 1
      }
    }),
    delay: async (milliseconds) => { elapsed += milliseconds },
    now: () => elapsed,
    pollMs: 1_000
  }), /did not converge/)
})
