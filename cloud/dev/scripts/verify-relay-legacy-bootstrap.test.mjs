import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relayWorkflowUrl } from './relay-repository.mjs'
import {
  parseLegacyBootstrapArguments,
  verifyLegacyBootstrap
} from './verify-relay-legacy-bootstrap.mjs'

const now = Date.parse('2026-08-10T22:10:00Z')
const digest = `sha256:${'a'.repeat(64)}`
const config = {
  directorOrigin: 'https://relay.example.com',
  cellOrigin: 'https://c3.relay.example.com',
  cellId: 'staging-gce-c3',
  admission: 'general',
  expectedImageDigest: digest,
  metricsAfter: now - 120_000,
  metricsFile: '/unused',
  runtimeStartedAfter: undefined,
  previousIncarnationDigest: undefined,
  hardCap: undefined,
  unobservedBound: undefined,
  capacityState: 'absent'
}

const metrics = [30, 60].map((secondsAgo) => ({
  timestamp: new Date(now - secondsAgo * 1_000).toISOString(),
  cellId: config.cellId,
  metricVersion: 1,
  totalConnections: 0,
  preAuthConnections: 0,
  controls: 0,
  splices: 0,
  pendingSplices: 0,
  queuedBytes: 0
}))

function response(body, status = 200) {
  return Response.json(body, { status })
}

function harness({
  runtime = {},
  status = {},
  ready = true,
  cell = config,
  runtimeHeartbeatFresh = true
} = {}) {
  return async (url) => {
    const path = new URL(url).pathname
    if (path === '/health') {
      return response(
        url.startsWith(config.directorOrigin)
          ? { ok: true, connectionCapacityProtocol: 2 }
          : { ok: true }
      )
    }
    if (path === '/ready') return ready ? response({ ok: true }) : response({ error: 'no' }, 503)
    if (path === '/v1/admin/runtime-status') {
      return response({
        v: 1,
        role: 'cell',
          cellId: cell.cellId,
          cellUrl: cell.cellOrigin,
        imageDigest: digest,
        ...runtime
      })
    }
    return response({
      status: {
        cellId: cell.cellId,
        cellUrl: cell.cellOrigin,
        enabled: true,
        admissionState: 'general',
        assignments: 12,
        reservedRequests: 0,
        activityLeases: 0,
        activityRequestUnits: 0,
        outgoingMigrations: 0,
        incomingMigrations: 0,
        connectionCapacity: null,
        runtime: {
          cellUrl: cell.cellOrigin,
          cellIncarnation: '00000000-0000-4000-8000-000000000001',
          startedAt: now - 90_000,
          ready: true,
          observedRequests: 0,
          lastHeartbeatAt: now - 1_000,
          heartbeatFresh: runtimeHeartbeatFresh
        },
        ...status
      }
    })
  }
}

test('parses the exact legacy bootstrap evidence boundary', () => {
  assert.deepEqual(
    parseLegacyBootstrapArguments([
      '--director-origin', config.directorOrigin,
      '--cell-origin', config.cellOrigin,
      '--cell-id', config.cellId,
      '--admission', 'general',
      '--expected-image-digest', digest,
      '--metrics-after', new Date(config.metricsAfter).toISOString(),
      '--metrics-file', '/tmp/metrics.json'
    ]),
    { ...config, metricsFile: '/tmp/metrics.json' }
  )
})

test('accepts the exact old runtime shape with two fresh zero samples', async () => {
  const result = await verifyLegacyBootstrap(config, {
    fetch: harness(),
    metrics,
    now: () => now,
    token: 'masked-token'
  })
  assert.deepEqual(
    { ...result, incarnationDigest: undefined },
    {
      cellId: config.cellId,
      admissionState: 'general',
      assignments: 12,
      metricSamples: 2,
      incarnationDigest: undefined
    }
  )
  assert.match(result.incarnationDigest, /^[a-f0-9]{64}$/)
})

test('rejects a new or unknown runtime shape on the legacy-only path', async () => {
  await assert.rejects(
    verifyLegacyBootstrap(config, {
      fetch: harness({ runtime: { draining: false } }),
      metrics,
      now: () => now,
      token: 'masked-token'
    }),
    /reviewed legacy contract/
  )
})

test('rejects active durable state and active runtime metrics', async () => {
  await assert.rejects(
    verifyLegacyBootstrap(config, {
      fetch: harness({ status: { activityLeases: 1 } }),
      metrics,
      now: () => now,
      token: 'masked-token'
    }),
    /durable activity/
  )
  await assert.rejects(
    verifyLegacyBootstrap(config, {
      fetch: harness(),
      metrics: metrics.map((entry, index) => ({
        ...entry,
        controls: index === 0 ? 1 : 0
      })),
      now: () => now,
      token: 'masked-token'
    }),
    /not quiescent/
  )
  await assert.rejects(
    verifyLegacyBootstrap(config, {
      fetch: harness(),
      metrics: metrics.map((entry) => ({ ...entry, pendingSplices: null })),
      now: () => now,
      token: 'masked-token'
    }),
    /pendingSplices is invalid/
  )
})

test('rejects stale, pre-boundary, or single runtime samples', async () => {
  for (const invalidMetrics of [
    metrics.map((entry) => ({ ...entry, timestamp: new Date(now - 180_000).toISOString() })),
    [metrics[0]],
    metrics.map((entry) => ({ ...entry, timestamp: new Date(now - 100_000).toISOString() }))
  ]) {
    await assert.rejects(
      verifyLegacyBootstrap(config, {
        fetch: harness(),
        metrics: invalidMetrics,
        now: () => now,
        token: 'masked-token'
      }),
      /samples|stale/
    )
  }
})

test('rejects the wrong legacy image and an unready cell', async () => {
  await assert.rejects(
    verifyLegacyBootstrap(config, {
      fetch: harness({ runtime: { imageDigest: `sha256:${'b'.repeat(64)}` } }),
      metrics,
      now: () => now,
      token: 'masked-token'
    }),
    /identity does not match/
  )
  await assert.rejects(
    verifyLegacyBootstrap(config, {
      fetch: harness({ ready: false }),
      metrics,
      now: () => now,
      token: 'masked-token'
    }),
    /readiness returned 503/
  )
})

test('binds the director heartbeat to the replacement boundary', async () => {
  const replacementConfig = { ...config, runtimeStartedAfter: now - 60_000 }
  await assert.rejects(
    verifyLegacyBootstrap(replacementConfig, {
      fetch: harness(),
      metrics,
      now: () => now,
      token: 'masked-token'
    }),
    /heartbeat predates/
  )
  await verifyLegacyBootstrap(replacementConfig, {
    fetch: harness({ status: { runtime: {
      cellUrl: config.cellOrigin,
      cellIncarnation: '00000000-0000-4000-8000-000000000002',
      startedAt: now - 30_000,
      ready: true,
      observedRequests: 0,
      lastHeartbeatAt: now - 1_000,
      heartbeatFresh: true
    } } }),
    metrics,
    now: () => now,
    token: 'masked-token'
  })
})

test('accepts a drained migration-only legacy target', async () => {
  const migrationConfig = { ...config, admission: 'migration-only' }
  const result = await verifyLegacyBootstrap(migrationConfig, {
    fetch: harness({ status: { admissionState: 'migration-only' } }),
    metrics,
    now: () => now,
    token: 'masked-token'
  })
  assert.equal(result.admissionState, 'migration-only')
})

test('accepts exact stale capacity during the director-first transition', async () => {
  const capacity = {
    hardCap: 600,
    unobservedBound: 60,
    controlRebindReserve: 100,
    ordinaryConnectionLimit: 500,
    normalAdmissionPause: 440,
    observedConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    pendingControlReservations: 0,
    heartbeatFresh: false
  }
  const transition = {
    ...config,
    admission: 'migration-only',
    hardCap: 600,
    unobservedBound: 60,
    capacityState: 'stale'
  }
  await verifyLegacyBootstrap(transition, {
    fetch: harness({ status: { admissionState: 'migration-only', connectionCapacity: capacity } }),
    metrics,
    now: () => now,
    token: 'masked-token'
  })
  await assert.rejects(
    verifyLegacyBootstrap(transition, {
      fetch: harness({ status: {
        admissionState: 'migration-only',
        connectionCapacity: { ...capacity, heartbeatFresh: true }
      } }),
      metrics,
      now: () => now,
      token: 'masked-token'
    }),
    /capacity does not match/
  )
})

test('resumes either legacy cell after the director update', async () => {
  const capacity = {
    hardCap: 600,
    unobservedBound: 60,
    controlRebindReserve: 100,
    ordinaryConnectionLimit: 500,
    normalAdmissionPause: 440,
    observedConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    pendingControlReservations: 0,
    heartbeatFresh: false
  }
  for (const number of [2, 3]) {
    const cell = {
      ...config,
      cellId: `staging-gce-c${number}`,
      cellOrigin: `https://c${number}.relay.example.com`,
      admission: 'migration-only',
      hardCap: 600,
      unobservedBound: 60,
      capacityState: 'absent-or-stale'
    }
    const cellMetrics = metrics.map((entry) => ({ ...entry, cellId: cell.cellId }))
    for (const connectionCapacity of [null, capacity]) {
      await verifyLegacyBootstrap(cell, {
        fetch: harness({
          cell,
          runtimeHeartbeatFresh: connectionCapacity === null,
          status: { admissionState: 'migration-only', connectionCapacity }
        }),
        metrics: cellMetrics,
        now: () => now,
        token: 'masked-token'
      })
    }
  }
})

test('requires a fresh director heartbeat before capacity is configured', async () => {
  await assert.rejects(
    verifyLegacyBootstrap(config, {
      fetch: harness({ runtimeHeartbeatFresh: false }),
      metrics,
      now: () => now,
      token: 'masked-token'
    }),
    /fresh, ready/
  )
})

test('requires a new director heartbeat incarnation after restart', async () => {
  const before = await verifyLegacyBootstrap(config, {
    fetch: harness(),
    metrics,
    now: () => now,
    token: 'masked-token'
  })
  await assert.rejects(
    verifyLegacyBootstrap(
      { ...config, previousIncarnationDigest: before.incarnationDigest },
      { fetch: harness(), metrics, now: () => now, token: 'masked-token' }
    ),
    /incarnation did not change/
  )
})

test('rejects same-instance samples written before restart completion', async () => {
  await assert.rejects(
    verifyLegacyBootstrap(
      { ...config, metricsAfter: now - 20_000 },
      { fetch: harness(), metrics, now: () => now, token: 'masked-token' }
    ),
    /post-boundary samples/
  )
})

test('the bootstrap workflow binds zero metrics to a replacement C3 instance', async () => {
  const { readFile } = await import('node:fs/promises')
  const workflow = await readFile(
    relayWorkflowUrl('bootstrap-relay-staging-capacity.yml'),
    'utf8'
  )
  assert.match(workflow, /resource\.labels\.instance_id=.*\$\{instance_id\}/)
  assert.match(workflow, /timestamp>=.*\$\{after\}/)
  assert.doesNotMatch(workflow, /legacy_c3_instance_id.*!=/)
  const c2Proof = workflow.indexOf('staging-gce-c2 general "${legacy_pre_boundary}"')
  const isolate = workflow.indexOf('--mode isolate', c2Proof)
  const drainedProof = workflow.indexOf('staging-gce-c3 migration-only', isolate)
  const recreate = workflow.indexOf('recreate-instances', drainedProof)
  const replacementProof = workflow.indexOf('"${legacy_c3_old_incarnation}"', recreate)
  const stable = workflow.indexOf('wait-until', recreate)
  const metricsBoundary = workflow.indexOf('legacy_c3_metrics_boundary=', stable)
  assert.ok(c2Proof < isolate && isolate < drainedProof && drainedProof < recreate)
  assert.ok(recreate < stable && stable < metricsBoundary && metricsBoundary < replacementProof)
  assert.match(workflow, /recreate-instances[\s\S]*?--instances "\$\{legacy_c3_instance\}"/)
  assert.match(workflow, /incarnation_args=\(--previous-incarnation-digest/)
  assert.match(workflow, /trap restore_legacy_c3_fallback EXIT/)
  assert.match(workflow, /--mode restore-fallback[\s\S]*--general-cell-ids staging-gce-c2/)
})
