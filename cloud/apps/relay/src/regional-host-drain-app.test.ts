import { describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

vi.mock('./authentication/admin-token-verifier.js', () => ({
  createAdminTokenVerifier: () => async (token: string, route?: string) =>
    token === 'deploy-token' ||
    (token === 'monitor-token' &&
      (!route ||
        route === '/v1/admin/regional-rehome-control' ||
        route === '/v1/admin/regional-rehome-preview')),
  createReadOnlyAdminTokenVerifier: () => async () => false,
  createRegionalRehomeControlApplyTokenVerifier: () => async (token: string) =>
    token === 'deploy-token',
  createRegionalRehomeRuntimeTokenVerifier: () => async (token: string) =>
    token === 'runtime-token',
  createRegionalRehomeTokenVerifier: () => async (token: string) => token === 'rehome-token',
  createRuntimeTokenVerifier: () => async (token: string) => token === 'runtime-token'
}))

vi.mock('./authentication/relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => async () => null,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'
import {
  REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
  REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
  REGIONAL_REHOME_TRUST_PROBE_USER_ID
} from './assignment/regional-rehome/regional-rehome-trust-probe.js'

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

describe('idle regional cutover endpoint', () => {
  it('authenticates and fences the source before invoking a cutover', async () => {
    const idleRehome = vi.fn(async () => ({ outcome: 'busy' }))
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      idleRehome,
      cellIncarnation,
      ready: vi.fn(async () => true)
    } as Parameters<typeof createRelayApp>[1])
    const input = {
      v: 1,
      attemptId: request.attemptId,
      userId: request.userId,
      relayHostId: request.relayHostId,
      sourceCellId: request.sourceCellId,
      sourceCellIncarnation: cellIncarnation,
      sourceAssignmentEpoch: 7,
      sourceGeneration: 1,
      targetCellId: 'target-cell',
      cohortPercent: 100,
      directorSafety: {
        observedAt: 100, sqlFailures: 0, reconnects: 0, controlActivityRecoveryFailures: 0,
        databasePoolWaiting: 0, databasePoolWaitersMax: 0, databasePoolWaitMsMax: 0
      }
    }
    const path = '/v1/admin/host-idle-rehome'
    expect((await postPath(app, path, 'runtime-token', input)).status).toBe(401)
    expect(
      (
        await postPath(app, path, 'rehome-token', {
          ...input,
          sourceCellIncarnation: '33333333-3333-4333-8333-333333333333'
        })
      ).status
    ).toBe(409)
    expect(idleRehome).not.toHaveBeenCalled()
    const response = await postPath(app, path, 'rehome-token', input)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ v: 1, outcome: 'busy' })
    expect(idleRehome).toHaveBeenCalledExactlyOnceWith(input)
  })
})

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
      (
        await post(app, 'rehome-token', {
          ...request,
          sourceCellIncarnation: '33333333-3333-4333-8333-333333333333'
        })
      ).status
    ).toBe(409)
    expect(drainHost).toHaveBeenCalledOnce()
  })

  it('rejects a failed asynchronous drain instead of acknowledging it', async () => {
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      drainHost: async () => {
        throw new Error('activity_cell_not_authoritative')
      },
      cellIncarnation,
      ready: vi.fn(async () => true)
    })
    const response = await post(app, 'rehome-token', request)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'activity_cell_not_authoritative' })
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

})

describe('regional rehome director controls', () => {

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
    expect(
      (
        await postPath(app, '/v1/admin/regional-rehome-control', 'deploy-token', {
          v: 1,
          action: 'inspect'
        })
      ).status
    ).toBe(200)
    const apply = {
      v: 1,
      action: 'apply',
      expectedGeneration: 0,
      enabled: true,
      notBefore: 100,
      ratePerMinute: 10,
      preferenceMaxAgeMs: 24 * 60 * 60_000,
      hostCooldownMs: 7 * 24 * 60 * 60_000,
      drainGraceMs: 60_000,
      confirmation: 'ENABLE_REGIONAL_REHOMING'
    }
    expect(
      (await postPath(app, '/v1/admin/regional-rehome-control', 'deploy-token', apply)).status
    ).toBe(200)
    expect(applyRegionalRehomeControl).toHaveBeenCalledOnce()
    expect(
      (
        await postPath(app, '/v1/admin/regional-rehome-control', 'monitor-token', {
          v: 1,
          action: 'inspect'
        })
      ).status
    ).toBe(200)
    expect(
      (await postPath(app, '/v1/admin/regional-rehome-control', 'monitor-token', apply)).status
    ).toBe(403)
    expect(
      (
        await postPath(app, '/v1/admin/regional-rehome-control', 'deploy-token', {
          ...apply,
          confirmation: 'DISABLE_REGIONAL_REHOMING'
        })
      ).status
    ).toBe(400)
    // The per-host cooldown is part of the durable shape an operator must state.
    const { hostCooldownMs: _omitted, ...withoutCooldown } = apply
    expect(
      (await postPath(app, '/v1/admin/regional-rehome-control', 'deploy-token', withoutCooldown))
        .status
    ).toBe(400)
    expect(applyRegionalRehomeControl).toHaveBeenCalledExactlyOnceWith(apply)
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
