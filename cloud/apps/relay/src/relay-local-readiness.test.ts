import { createServer } from 'node:http'
import type { Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL_FLAG_DEFAULTS, type CellFlags } from './cell-flags.js'
import type { RelayConfig } from './config.js'
import type { RelayDatabase } from './database.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'
import { createRelayLocalReadiness } from './relay-local-readiness.js'
import { createRelayServer } from './relay-server.js'
import { createRelayApp } from './app.js'

describe('local readiness verdict', () => {
  it('is not ready before the server listens', () => {
    const verdict = createRelayLocalReadiness({
      listening: () => false,
      keys: { jwks: () => ({ keys: [] }), reload: vi.fn(async () => {}) },
      failingDependencies: () => []
    })
    expect(verdict()).toEqual({ ready: false, reason: 'not_listening' })
  })

  it('loads the verifier keys itself, once at a time, and is ready after they land', async () => {
    let keys: unknown
    let finishLoad!: () => void
    const reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = () => {
            keys = { keys: [] }
            resolve()
          }
        })
    )
    const verdict = createRelayLocalReadiness({
      listening: () => true,
      keys: { jwks: () => keys, reload },
      failingDependencies: () => ['sql']
    })
    expect(verdict()).toEqual({ ready: false, reason: 'keys_not_loaded' })
    expect(verdict()).toEqual({ ready: false, reason: 'keys_not_loaded' })
    expect(reload).toHaveBeenCalledTimes(1)
    finishLoad()
    await Promise.resolve()
    expect(verdict()).toEqual({ ready: true, failing: ['sql'] })
  })

  it('retries a key load that failed', async () => {
    const reload = vi.fn(async () => {
      throw new Error('jwks unreachable')
    })
    const verdict = createRelayLocalReadiness({
      listening: () => true,
      keys: { jwks: () => undefined, reload },
      failingDependencies: () => []
    })
    verdict()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    verdict()
    expect(reload).toHaveBeenCalledTimes(2)
  })
})

// E-dep-3 in miniature: the database is down from boot, so it never enters a grace window.
describe('cell /ready with the database down', () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  async function listen(server: Server): Promise<string> {
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('not listening')
    return `http://127.0.0.1:${address.port}`
  }

  async function startCell(applied: () => AppliedControlFlags<CellFlags>) {
    const jwksBase = await listen(
      createServer((_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end('{"keys":[]}')
      })
    )
    const relay = createRelayServer(cellConfig(`${jwksBase}/jwks`), unreachableDatabase(), {
      cellFlags: applied
    })
    const base = await listen(relay.server)
    return { relay, base }
  }

  it('stays out of rotation with the switch off', async () => {
    const { relay, base } = await startCell(() => ({ generation: 0, flags: CELL_FLAG_DEFAULTS }))
    const response = await fetch(`${base}/ready`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'dependency_unavailable' })
    expect(await relay.ready()).toBe(false)
  })

  it('answers 200 with the switch on, while the heartbeat keeps the SQL verdict', async () => {
    const { relay, base } = await startCell(() => ({
      generation: 3,
      flags: { ...CELL_FLAG_DEFAULTS, readinessLocal: true }
    }))
    // The first answer starts the verifier's own key load.
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({ error: 'keys_not_loaded' })
    await vi.waitFor(async () => expect((await fetch(`${base}/ready`)).status).toBe(200))
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({
      ok: true,
      degraded: true,
      dependency: ['sql']
    })
    expect(await relay.ready()).toBe(false)
  })
})

function unreachableDatabase(): RelayDatabase {
  const refuse = async (): Promise<never> => {
    throw new Error('connect ECONNREFUSED')
  }
  return {
    dialect: 'postgres',
    query: refuse,
    queryLocked: refuse,
    transaction: refuse,
    close: async () => {}
  }
}

function cellConfig(jwksUrl: string): RelayConfig {
  return {
    port: 0,
    publicUrl: 'https://c7.relay.example.test',
    cellUrl: 'https://c7.relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl,
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c7',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'relay-cell@example.test',
    adminJwksUrl: jwksUrl,
    databasePoolMax: 10,
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

describe('one host-token key set per process', () => {
  it('verifies HTTP relay tokens with the key set the server shares', async () => {
    const keys = vi.fn(async () => {
      throw new Error('no key in this test')
    })
    const app = createRelayApp(
      { ...cellConfig('https://auth.example.test/jwks'), role: 'director', cellId: 'director' },
      {
        store: {} as never,
        assignments: {} as never,
        drain: vi.fn(),
        ready: vi.fn(async () => true),
        // SAFETY: jwtVerify only calls the key set; the jwks/reload members are unused here.
        relayJwks: keys as never
      }
    )
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = `${encode({ alg: 'ES256' })}.${encode({ sub: 'user-1' })}.c2ln`
    const response = await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: 'abcdefghijklmnop' })
    })
    expect(response.status).toBe(401)
    expect(keys).toHaveBeenCalledTimes(1)
  })
})
