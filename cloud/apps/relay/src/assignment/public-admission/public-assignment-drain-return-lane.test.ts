import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type RelayAssignment,
  type ResolvedRelayAssignment
} from '../assignment-store.js'
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('drain-return lane', () => {
  it('sends a host whose home is roll-isolated past a busy sticky lane', async () => {
    const drained = 'dddddddddddddddd'
    const ordinary = 'oooooooooooooooo'
    const replacement = deferred<RelayAssignment>()
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      relayHostId === drained ? await replacement.promise : assignment('cell-o', relayHostId)
    )
    const resolve = vi.fn(async ({ relayHostId }: { relayHostId: string }) =>
      relayHostId === drained ? isolatedHome(relayHostId) : assignment('cell-o', relayHostId)
    )
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: { assign, resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    // The re-placement holds the drain lane; the sticky lane's only slot is free.
    const moving = app.request('/v1/assign', assignmentRequest(drained, { reconnect: true }))
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    const reconnect = await app.request(
      '/v1/assign',
      assignmentRequest(ordinary, { reconnect: true })
    )

    expect(reconnect.status).toBe(200)
    replacement.resolve(assignment('cell-new', drained))
    expect((await moving).status).toBe(200)
  })

})

function assignmentRequest(relayHostId: string, extra: { reconnect?: boolean } = {}): RequestInit {
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

function isolatedHome(relayHostId: string): ResolvedRelayAssignment {
  return { ...assignment('cell-isolated', relayHostId), homeCellRollIsolated: true }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function config(): RelayConfig {
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
    dataDir: './data'
  }
}
