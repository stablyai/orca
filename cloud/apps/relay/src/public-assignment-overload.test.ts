import { describe, expect, it, vi } from 'vitest'
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

import { createRelayApp } from './app.js'

describe('public assignment overload', () => {
  it('rejects duplicate and excess work before it reaches assignment state', async () => {
    const hostA = 'aaaaaaaaaaaaaaaa'
    const hostB = 'bbbbbbbbbbbbbbbb'
    const hostC = 'cccccccccccccccc'
    const pending = new Map<string, ReturnType<typeof deferred<RelayAssignment>>>()
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      const operation = deferred<RelayAssignment>()
      pending.set(relayHostId, operation)
      return await operation.promise
    })
    const app = createRelayApp(config({ publicAssignmentQueueMax: 0 }), {
      store: {} as never,
      assignments: { assign } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const first = app.request('/v1/assign', assignmentRequest(hostA))
    await vi.waitFor(() => expect(pending.has(hostA)).toBe(true))
    const duplicate = await app.request('/v1/assign', assignmentRequest(hostA))
    expect(duplicate.status).toBe(503)

    const second = app.request('/v1/assign', assignmentRequest(hostB))
    await vi.waitFor(() => expect(pending.has(hostB)).toBe(true))
    const excess = await app.request('/v1/assign', assignmentRequest(hostC))
    expect(excess.status).toBe(503)
    expect(excess.headers.get('retry-after')).toBe('5')
    expect(assign).toHaveBeenCalledTimes(2)

    pending.get(hostA)?.resolve(assignment('cell-a', hostA))
    pending.get(hostB)?.resolve(assignment('cell-b', hostB))
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect((await app.request('/v1/assign', assignmentRequest(hostA))).status).toBe(503)
    expect(assign).toHaveBeenCalledTimes(2)
  })

  it('fairly drains a bounded incident-scale burst without raising database concurrency', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<RelayAssignment>>>()
    const admittedHosts: string[] = []
    let active = 0
    let highWater = 0
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      admittedHosts.push(relayHostId)
      active++
      highWater = Math.max(highWater, active)
      const operation = deferred<RelayAssignment>()
      pending.set(relayHostId, operation)
      try {
        return await operation.promise
      } finally {
        active--
        pending.delete(relayHostId)
      }
    })
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const hosts = Array.from(
      { length: 430 },
      (_, index) => `host-${String(index).padStart(11, '0')}`
    )

    const firstWave = hosts.map((host) =>
      app.request('/v1/assign', assignmentRequest(host))
    )
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2))
    const retryWave = await Promise.all(
      hosts.map((host) => app.request('/v1/assign', assignmentRequest(host)))
    )

    expect(retryWave.every((response) => response.status === 503)).toBe(true)
    expect(assign).toHaveBeenCalledTimes(2)
    while (assign.mock.calls.length < 130) {
      const activeOperations = [...pending]
      const expectedCalls = assign.mock.calls.length + activeOperations.length
      for (const [host, operation] of activeOperations) {
        operation.resolve(assignment(`cell-${host}`, host))
      }
      await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(expectedCalls))
    }
    for (const [host, operation] of pending) {
      operation.resolve(assignment(`cell-${host}`, host))
    }
    const firstResponses = await Promise.all(firstWave)
    expect(firstResponses.filter((response) => response.status === 200)).toHaveLength(130)
    expect(firstResponses.filter((response) => response.status === 503)).toHaveLength(300)
    expect(admittedHosts).toEqual(hosts.slice(0, 130))
    expect(highWater).toBe(2)
  })

  it('reserves one bounded resolve lane while assignment work is saturated', async () => {
    const pendingAssignments = new Map<string, ReturnType<typeof deferred<RelayAssignment>>>()
    const pendingResolve = deferred<{ userId: string; relayDeviceId: string } | null>()
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      const operation = deferred<RelayAssignment>()
      pendingAssignments.set(relayHostId, operation)
      return await operation.promise
    })
    const resolveResume = vi.fn(async () => await pendingResolve.promise)
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      assignment('target-cell', relayHostId)
    )
    const app = createRelayApp(config({ publicAssignmentQueueMax: 0 }), {
      store: { resolveResume } as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const assignmentA = app.request('/v1/assign', assignmentRequest('aaaaaaaaaaaaaaaa'))
    const assignmentB = app.request('/v1/assign', assignmentRequest('bbbbbbbbbbbbbbbb'))
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2))

    const recovery = app.request('/v1/resolve', resolveRequest('cccccccccccccccc', 1))
    await Promise.resolve()
    expect(resolveResume).not.toHaveBeenCalled()
    const excessResolve = await app.request(
      '/v1/resolve',
      resolveRequest('dddddddddddddddd', 2)
    )
    const excessAssign = await app.request('/v1/assign', assignmentRequest('eeeeeeeeeeeeeeee'))

    expect(excessResolve.status).toBe(503)
    expect(excessAssign.status).toBe(503)
    expect(assign).toHaveBeenCalledTimes(2)
    expect(resolveResume).not.toHaveBeenCalled()

    pendingAssignments
      .get('aaaaaaaaaaaaaaaa')
      ?.resolve(assignment('cell-a', 'aaaaaaaaaaaaaaaa'))
    expect((await assignmentA).status).toBe(200)
    await vi.waitFor(() => expect(resolveResume).toHaveBeenCalledTimes(1))
    pendingResolve.resolve({ userId: 'user-1', relayDeviceId: 'device-1' })
    expect((await recovery).status).toBe(200)
    expect(resolve).toHaveBeenCalledTimes(1)

    for (const [host, operation] of pendingAssignments) {
      operation.resolve(assignment(`cell-${host}`, host))
    }
    expect((await assignmentB).status).toBe(200)
  })
})

function assignmentRequest(relayHostId: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relayHostId}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, relayHostId })
  }
}

function resolveRequest(relayHostId: string, fill: number): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      relayHostId,
      resumeToken: Buffer.alloc(32, fill).toString('base64url')
    })
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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
