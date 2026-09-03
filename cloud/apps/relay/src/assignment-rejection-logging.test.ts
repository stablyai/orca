import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayAssignment } from './assignment-store.js'
import type { RelayConfig } from './config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({
    sub: 'user-1',
    relayHostId: token
  }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp, relayHostLogDigest } from './app.js'

describe('assignment rejection logging', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('logs the store reason and host digest when assign() rejects on capacity', async () => {
    const host = 'hhhhhhhhhhhhhhhh'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: vi.fn(async () => {
          throw new Error('relay_capacity_exhausted')
        }),
        resolve: vi.fn(async () => assignment('cell-r', host))
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const hinted = await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))

    expect(hinted.status).toBe(503)
    expect(await hinted.json()).toEqual({ error: 'relay_capacity_exhausted' })
    const line = warn.mock.calls.map((call) => String(call[0])).find((entry) =>
      entry.includes('assignment rejected')
    )
    expect(line).toContain('route=assign')
    expect(line).toContain('lane=sticky')
    expect(line).toContain('hinted=true')
    expect(line).toContain('reason=relay_capacity_exhausted')
    expect(line).toContain(`host=${relayHostLogDigest(host)}`)
    expect(line).not.toContain(host)
  })

  it('logs an unhinted placement rejection without the raw host id', async () => {
    const host = 'gggggggggggggggg'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: vi.fn(async () => {
          throw new Error('relay_connection_headroom_exhausted')
        }),
        resolve: vi.fn(async () => null)
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const response = await app.request('/v1/assign', assignmentRequest(host))

    expect(response.status).toBe(503)
    const line = warn.mock.calls.map((call) => String(call[0])).find((entry) =>
      entry.includes('assignment rejected')
    )
    expect(line).toContain('route=assign')
    expect(line).toContain('lane=placement')
    expect(line).toContain('hinted=false')
    expect(line).toContain('reason=relay_connection_headroom_exhausted')
    expect(line).not.toContain(host)
  })

  it('names the throttled host once per window and closes it with the suppressed count', async () => {
    vi.useFakeTimers()
    const host = 'mmmmmmmmmmmmmmmm'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: vi.fn(async () => assignment('cell-r', host)),
        resolve: vi.fn(async () => null)
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    expect((await app.request('/v1/assign', assignmentRequest(host))).status).toBe(200)
    expect((await app.request('/v1/assign', assignmentRequest(host))).status).toBe(503)
    expect((await app.request('/v1/assign', assignmentRequest(host))).status).toBe(503)

    const throttled = (): string[] =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((entry) => entry.includes('reason=host-rate-limited'))
    expect(throttled()).toHaveLength(1)
    expect(throttled()[0]).toContain('route=assign')
    expect(throttled()[0]).toContain('lane=placement')
    expect(throttled()[0]).toContain(`host=${relayHostLogDigest(host)}`)
    expect(throttled()[0]).not.toContain('suppressed=')
    expect(throttled()[0]).not.toContain(host)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(throttled()).toHaveLength(2)
    expect(throttled()[1]).toContain('suppressed=1')
    expect(throttled()[1]).toContain(`host=${relayHostLogDigest(host)}`)
  })

  it('stays silent for successful assignments', async () => {
    const host = 'ssssssssssssssss'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: vi.fn(async () => assignment('cell-r', host)),
        resolve: vi.fn(async () => null)
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    expect((await app.request('/v1/assign', assignmentRequest(host))).status).toBe(200)
    expect(
      warn.mock.calls.map((call) => String(call[0])).filter((entry) =>
        entry.includes('assignment rejected')
      )
    ).toEqual([])
  })
})

function assignmentRequest(
  relayHostId: string,
  extra: Record<string, unknown> = {}
): RequestInit & { headers: Record<string, string> } {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relayHostId}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, relayHostId, ...extra })
  }
}

function assignment(cellId: string, relayHostId: string): RelayAssignment {
  return {
    userId: 'user-1',
    relayHostId,
    cellId,
    cellUrl: `https://${cellId}.relay.example.test`,
    assignmentEpoch: 1,
    leaseExpiresAt: Date.now() + 300_000
  }
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
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

describe('assignment grant logging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs sticky grants with cell id and host digest only', async () => {
    const host = 'gggggggggggggggg'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: vi.fn(async () => assignment('cell-r', host)),
        resolve: vi.fn(async () => assignment('cell-r', host))
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const response = await app.request('/v1/assign', assignmentRequest(host, { reconnect: true }))

    expect(response.status).toBe(200)
    const line = warn.mock.calls.map((call) => String(call[0])).find((entry) =>
      entry.includes('assignment granted')
    )
    expect(line).toContain('lane=sticky')
    expect(line).toContain('cell=cell-r')
    expect(line).toContain(`host=${relayHostLogDigest(host)}`)
    expect(line).not.toContain(host)
  })

  it('does not log unhinted placement grants', async () => {
    const host = 'pppppppppppppppp'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {
        assign: vi.fn(async () => assignment('cell-r', host)),
        resolve: vi.fn(async () => null)
      } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    expect((await app.request('/v1/assign', assignmentRequest(host))).status).toBe(200)
    expect(
      warn.mock.calls.map((call) => String(call[0])).filter((entry) =>
        entry.includes('assignment granted')
      )
    ).toEqual([])
  })
})
