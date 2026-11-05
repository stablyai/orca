import { createServer } from 'node:http'
import type { Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL_FLAG_DEFAULTS, type CellFlags } from '../cell/control-flags/cell-flags.js'
import type { RelayConfig } from '../config.js'
import type { RelayDatabase } from '../database/database.js'
import type { AppliedControlFlags } from '../cell/control-flags/relay-control-flag-channel.js'
import { createRelayServer } from '../relay-server.js'

// Boot-down database never earns a grace window (E-dep-3).
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
