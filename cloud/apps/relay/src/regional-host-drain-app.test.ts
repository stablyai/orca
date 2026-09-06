import { describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

vi.mock('./admin-token-verifier.js', () => ({
  createAdminTokenVerifier: () => async (token: string, route?: string) =>
    token === 'deploy-token' ||
    (token === 'monitor-token' &&
      (!route || route === '/v1/admin/regional-rehome-control')),
  createReadOnlyAdminTokenVerifier: () => async () => false,
  createRegionalRehomeControlApplyTokenVerifier: () => async (token: string) =>
    token === 'deploy-token',
  createRegionalRehomeRuntimeTokenVerifier: () => async (token: string) =>
    token === 'runtime-token',
  createRegionalRehomeTokenVerifier: () => async (token: string) => token === 'rehome-token',
  createRuntimeTokenVerifier: () => async (token: string) => token === 'runtime-token'
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => async () => null,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'
import { RelayObservability } from './relay-observability.js'
import { emptyPostgresPoolPressureCounts } from './postgres-pool-pressure.js'
import {
  REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
  REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
  REGIONAL_REHOME_TRUST_PROBE_USER_ID
} from './regional-rehome-trust-probe.js'

const cellIncarnation = '11111111-1111-4111-8111-111111111111'
const request = {
  v: 1,
  attemptId: '22222222-2222-4222-8222-222222222222',
  userId: 'user-1',
  relayHostId: 'abcdefghijklmnop',
  sourceCellId: 'production-gce-c7',
  sourceCellIncarnation: cellIncarnation,
  sourceAssignmentEpoch: 7,
  graceMs: 60_000
}

describe('regional host drain endpoint', () => {
  it('accepts only the dedicated identity and exact cell generation', async () => {
    const drainHost = vi.fn(() => 'accepted' as const)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost,
      cellIncarnation,
      ready: vi.fn(async () => true)
    })

    const accepted = await post(app, 'rehome-token', request)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ v: 1, outcome: 'accepted' })
    expect(drainHost).toHaveBeenCalledWith(request)

    expect((await post(app, 'deploy-token', request)).status).toBe(401)
    expect(
      (await post(app, 'rehome-token', {
        ...request,
        sourceCellIncarnation: '33333333-3333-4333-8333-333333333333'
      })).status
    ).toBe(409)
    expect(drainHost).toHaveBeenCalledOnce()
  })

  it('rejects malformed identities before touching the session registry', async () => {
    const drainHost = vi.fn(() => 'accepted' as const)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost,
      cellIncarnation,
      ready: vi.fn(async () => true)
    })

    expect(
      (await post(app, 'rehome-token', { ...request, relayHostId: 'raw-host-id' })).status
    ).toBe(400)
    expect(drainHost).not.toHaveBeenCalled()
  })

  it('is unavailable on the director', async () => {
    const app = createRelayApp(config({ role: 'director', cellId: 'director' }), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost: vi.fn(() => 'accepted' as const),
      cellIncarnation,
      ready: vi.fn(async () => true)
    })
    expect((await post(app, 'rehome-token', request)).status).toBe(404)
  })

  it('proves the shared runtime identity is rejected without touching a session', async () => {
    const drainHost = vi.fn(() => 'host-not-connected' as const)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost,
      regionalRehomeTrustProbeHostExists: vi.fn(() => false),
      regionalRehomeIdentityToken: vi.fn(async () => 'runtime-token'),
      cellIncarnation,
      ready: vi.fn(async () => true)
    })
    const probe = {
      ...request,
      attemptId: REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
      userId: REGIONAL_REHOME_TRUST_PROBE_USER_ID,
      relayHostId: REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
      sourceAssignmentEpoch: 1,
      graceMs: 0
    }

    expect(REGIONAL_REHOME_TRUST_PROBE_HOST_ID).toHaveLength(16)
    for (let call = 0; call < 2; call++) {
      const response = await post(app, 'rehome-token', probe)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        v: 1,
        outcome: 'host-not-connected',
        sharedRuntimeIdentityRejected: true
      })
    }
    expect(drainHost).toHaveBeenCalledTimes(2)
  })

  it('fails closed if the synthetic host is not provably absent', async () => {
    const drainHost = vi.fn(() => 'host-not-connected' as const)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost,
      regionalRehomeTrustProbeHostExists: vi.fn(() => true),
      regionalRehomeIdentityToken: vi.fn(async () => 'runtime-token'),
      cellIncarnation,
      ready: vi.fn(async () => true)
    })
    const response = await post(app, 'rehome-token', {
      ...request,
      attemptId: REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
      userId: REGIONAL_REHOME_TRUST_PROBE_USER_ID,
      relayHostId: REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
      sourceAssignmentEpoch: 1,
      graceMs: 0
    })

    expect(response.status).toBe(409)
    expect(drainHost).not.toHaveBeenCalled()
  })

  it('rechecks synthetic host absence after asynchronous identity proof', async () => {
    let hostExists = false
    const drainHost = vi.fn(() => 'host-not-connected' as const)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost,
      regionalRehomeTrustProbeHostExists: vi.fn(() => hostExists),
      regionalRehomeIdentityToken: vi.fn(async () => {
        hostExists = true
        return 'runtime-token'
      }),
      cellIncarnation,
      ready: vi.fn(async () => true)
    })
    const response = await post(app, 'rehome-token', {
      ...request,
      attemptId: REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
      userId: REGIONAL_REHOME_TRUST_PROBE_USER_ID,
      relayHostId: REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
      sourceAssignmentEpoch: 1,
      graceMs: 0
    })

    expect(response.status).toBe(409)
    expect(drainHost).not.toHaveBeenCalled()
  })

  it('fails closed when the cell cannot prove its runtime identity rejection', async () => {
    const drainHost = vi.fn(() => 'host-not-connected' as const)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost,
      regionalRehomeTrustProbeHostExists: vi.fn(() => false),
      regionalRehomeIdentityToken: vi.fn(async () => 'rehome-token'),
      cellIncarnation,
      ready: vi.fn(async () => true)
    })
    const response = await post(app, 'rehome-token', {
      ...request,
      attemptId: REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
      userId: REGIONAL_REHOME_TRUST_PROBE_USER_ID,
      relayHostId: REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
      sourceAssignmentEpoch: 1,
      graceMs: 0
    })

    expect(response.status).toBe(409)
    expect(drainHost).not.toHaveBeenCalled()
  })
})

describe('regional rehome director controls', () => {
  it('records cell capability separately from the legacy heartbeat contract', async () => {
    const recordCellRegionalRehomeStatus = vi.fn().mockResolvedValue(undefined)
    const app = createRelayApp(config({ role: 'director', cellId: 'director' }), {
      store: {} as never,
      assignments: { recordCellRegionalRehomeStatus } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const body = {
      v: 1,
      cellId: 'production-gce-c7',
      cellIncarnation,
      regionalRehomeProtocol: 1,
      safety: {
        observedAt: 100,
        sqlFailures: 0,
        reconnects: 0,
        controlActivityRecoveryFailures: 0,
        databasePoolWaiting: 0,
        databasePoolWaitersMax: 0,
        databasePoolWaitMsMax: 0
      }
    }
    const response = await postPath(
      app,
      '/v1/admin/cell-rehome-status',
      'runtime-token',
      body
    )

    expect(response.status).toBe(200)
    expect(recordCellRegionalRehomeStatus).toHaveBeenCalledWith(body)
  })

  it('accepts the exact safety payload the cell heartbeat composes', async () => {
    // Why: index.ts spreads the FULL pool-pressure counts into safety; a
    // strict schema missing any produced field 400s every heartbeat (the
    // 2026-08-15..26 outage that left all cells at rehome protocol 0).
    const recordCellRegionalRehomeStatus = vi.fn().mockResolvedValue(undefined)
    const app = createRelayApp(config({ role: 'director', cellId: 'director' }), {
      store: {} as never,
      assignments: { recordCellRegionalRehomeStatus } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c7', region: 'us-central1' },
      () => {}
    )
    observability.stop()
    const body = {
      v: 1,
      cellId: 'production-gce-c7',
      cellIncarnation,
      regionalRehomeProtocol: 1,
      safety: {
        ...observability.regionalRehomeRuntimeSafety(),
        ...emptyPostgresPoolPressureCounts()
      }
    }
    const response = await postPath(
      app,
      '/v1/admin/cell-rehome-status',
      'runtime-token',
      body
    )

    expect(response.status).toBe(200)
    expect(recordCellRegionalRehomeStatus).toHaveBeenCalledWith(body)
  })

  it('applies the durable switch only with matching confirmation', async () => {
    const inspectRegionalRehomeControl = vi.fn().mockResolvedValue({
      generation: 0,
      enabled: false
    })
    const applyRegionalRehomeControl = vi.fn(async (input) => ({
      ...input,
      generation: input.expectedGeneration + 1
    }))
    const app = createRelayApp(config({ role: 'director', cellId: 'director' }), {
      store: {} as never,
      assignments: {
        inspectRegionalRehomeControl,
        applyRegionalRehomeControl
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    expect((await postPath(
      app,
      '/v1/admin/regional-rehome-control',
      'deploy-token',
      { v: 1, action: 'inspect' }
    )).status).toBe(200)
    const apply = {
      v: 1,
      action: 'apply',
      expectedGeneration: 0,
      enabled: true,
      notBefore: 100,
      ratePerMinute: 10,
      preferenceMaxAgeMs: 24 * 60 * 60_000,
      drainGraceMs: 60_000,
      confirmation: 'ENABLE_REGIONAL_REHOMING'
    }
    expect((await postPath(
      app,
      '/v1/admin/regional-rehome-control',
      'deploy-token',
      apply
    )).status).toBe(200)
    expect(applyRegionalRehomeControl).toHaveBeenCalledOnce()
    expect((await postPath(
      app,
      '/v1/admin/regional-rehome-control',
      'monitor-token',
      { v: 1, action: 'inspect' }
    )).status).toBe(200)
    expect((await postPath(
      app,
      '/v1/admin/regional-rehome-control',
      'monitor-token',
      apply
    )).status).toBe(403)
    expect((await postPath(
      app,
      '/v1/admin/regional-rehome-control',
      'deploy-token',
      { ...apply, confirmation: 'DISABLE_REGIONAL_REHOMING' }
    )).status).toBe(400)
  })

  it('probes dedicated trust twice and returns only aggregate proof', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const cellDeploymentStatus = vi.fn().mockResolvedValue({
      cellId: 'production-gce-c7',
      cellUrl: 'https://c7.relay.example.test',
      region: 'us-central1',
      runtime: {
        cellIncarnation,
        ready: true,
        heartbeatFresh: true,
        regionalRehomeProtocol: 1
      }
    })
    const app = createRelayApp(config({ role: 'director', cellId: 'director' }), {
      store: {} as never,
      assignments: { cellDeploymentStatus } as never,
      drain: vi.fn(),
      regionalRehomeIdentityToken: vi.fn(async () => 'rehome-token'),
      regionalRehomeFetch: (async (url, init) => {
        requests.push({ url: String(url), init })
        return Response.json({
          v: 1,
          outcome: 'host-not-connected',
          sharedRuntimeIdentityRejected: true
        })
      }) as typeof fetch,
      ready: vi.fn(async () => true)
    })
    const response = await postPath(
      app,
      '/v1/admin/regional-rehome-trust-probe',
      'deploy-token',
      { v: 1, sourceCellId: 'production-gce-c7', sourceCellIncarnation: cellIncarnation }
    )

    expect(response.status).toBe(200)
    const responseBody = await response.json()
    expect(responseBody).toEqual({
      v: 1,
      dedicatedIdentity: {
        accepted: true,
        firstOutcome: 'host-not-connected',
        secondOutcome: 'host-not-connected',
        idempotent: true
      },
      sharedRuntimeIdentityRejected: true,
      proven: true
    })
    expect(requests).toHaveLength(2)
    expect(requests.map(({ url }) => url)).toEqual([
      'https://c7.relay.example.test/v1/admin/host-drain',
      'https://c7.relay.example.test/v1/admin/host-drain'
    ])
    const bodies = requests.map(({ init }) => JSON.parse(String(init?.body)))
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toMatchObject({
      attemptId: REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
      userId: REGIONAL_REHOME_TRUST_PROBE_USER_ID,
      relayHostId: REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
      sourceAssignmentEpoch: 1,
      graceMs: 0
    })
    expect(requests.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true)
    expect(JSON.stringify(responseBody)).not.toContain('rehome-token')
  })

  it('restricts trust probes to deploy authorization and strict input', async () => {
    const app = createRelayApp(config({ role: 'director', cellId: 'director' }), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const body = {
      v: 1,
      sourceCellId: 'production-gce-c7',
      sourceCellIncarnation: cellIncarnation
    }
    expect((await postPath(
      app,
      '/v1/admin/regional-rehome-trust-probe',
      'monitor-token',
      body
    )).status).toBe(401)
    expect((await postPath(
      app,
      '/v1/admin/regional-rehome-trust-probe',
      'deploy-token',
      { ...body, unexpected: true }
    )).status).toBe(400)
  })

  it('fails closed when the source rejects the dedicated identity', async () => {
    const cellDeploymentStatus = vi.fn().mockResolvedValue({
      cellUrl: 'https://c7.relay.example.test',
      region: 'us-central1',
      runtime: {
        cellIncarnation,
        ready: true,
        heartbeatFresh: true,
        regionalRehomeProtocol: 1
      }
    })
    const sourceFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: 'invalid_token' }, { status: 401 })
    )
    const app = createRelayApp(config({ role: 'director', cellId: 'director' }), {
      store: {} as never,
      assignments: { cellDeploymentStatus } as never,
      drain: vi.fn(),
      regionalRehomeIdentityToken: vi.fn(async () => 'rehome-token'),
      regionalRehomeFetch: sourceFetch,
      ready: vi.fn(async () => true)
    })
    const response = await postPath(
      app,
      '/v1/admin/regional-rehome-trust-probe',
      'deploy-token',
      { v: 1, sourceCellId: 'production-gce-c7', sourceCellIncarnation: cellIncarnation }
    )

    expect(response.status).toBe(409)
    expect(sourceFetch).toHaveBeenCalledOnce()
    expect(JSON.stringify(await response.json())).not.toContain('rehome-token')
  })
})

async function post(
  app: ReturnType<typeof createRelayApp>,
  token: string,
  body: unknown
): Promise<Response> {
  return await app.request('/v1/admin/host-drain', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

async function postPath(
  app: ReturnType<typeof createRelayApp>,
  path: string,
  token: string,
  body: unknown
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://c7.relay.example.test',
    cellUrl: 'https://c7.relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c7',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    rehomeDirectorServiceAccount: 'relay-director@example.test',
    rehomeAudience: 'https://relay.example.test/v1/admin/host-drain',
    runtimeServiceAccount: 'relay-cell@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 10,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data',
    ...overrides
  }
}
