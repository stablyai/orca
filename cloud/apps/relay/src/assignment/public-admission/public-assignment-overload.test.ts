import { describe, expect, it, vi } from 'vitest'
import type { RelayAssignment } from '../assignment-store.js'
import type { RelayConfig } from '../../config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({
    sub: 'user-1',
    relayHostId: token
  }))
}))

vi.mock('../../authentication/relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from '../../app.js'

describe('public assignment overload', () => {

  it('refuses an oversized chunked body before parsing it, sparing only the reserve routes', async () => {
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: {} as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    // No Content-Length: the per-route header check alone would let this whole body be buffered.
    const chunked = (bytes: number): RequestInit & { duplex: 'half' } => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('"'.padEnd(bytes, 'a')))
          controller.close()
        }
      }),
      duplex: 'half'
    })
    const refused = await app.request('/v1/resolve', chunked(64 * 1024))
    expect(refused.status).toBe(413)
    expect(await refused.json()).toEqual({ error: 'request_too_large' })
    // Reserve bodies may reach 16 KiB, so the 4 KiB app limit must not answer for them. An
    // unavailable route refuses before its own limit.
    const reserve = await app.request('/internal/reserve', chunked(6 * 1024))
    expect(reserve.status).toBe(404)
    expect(await reserve.json()).toEqual({ error: 'reserve_unavailable' })
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
    const excessResolve = await app.request(
      '/v1/resolve',
      resolveRequest('dddddddddddddddd', 2)
    )
    const excessAssign = await app.request('/v1/assign', assignmentRequest('eeeeeeeeeeeeeeee'))

    expect(excessResolve.status).toBe(503)
    expect(excessAssign.status).toBe(503)

    pendingAssignments
      .get('aaaaaaaaaaaaaaaa')
      ?.resolve(assignment('cell-a', 'aaaaaaaaaaaaaaaa'))
    expect((await assignmentA).status).toBe(200)
    await vi.waitFor(() => expect(resolveResume).toHaveBeenCalledTimes(1))
    pendingResolve.resolve({ userId: 'user-1', relayDeviceId: 'device-1' })
    expect((await recovery).status).toBe(200)

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
