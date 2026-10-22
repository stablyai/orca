import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createTcpServer, connect, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelayConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { createRelayReadiness } from './relay-readiness.js'
import { createRelayServer } from './relay-server.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// c25 exited after 45 s of boot retries when its database was unreachable, and the MIG
// recreated it into the same loop. A cell now opens a lazy pool and listens at once.
describePostgres('cell boot while PostgreSQL is unreachable', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('listens with /health 200 and /ready 503, then turns ready once the database answers', async () => {
    const proxyPort = await unusedPort()
    const target = new URL(databaseUrl!)
    const viaProxy = new URL(databaseUrl!)
    viaProxy.hostname = '127.0.0.1'
    viaProxy.port = String(proxyPort)

    const startedAt = performance.now()
    const database = await openRelayDatabase({
      databaseUrl: viaProxy.toString(),
      dataDir: '',
      appliesPostgresSchema: false
    })
    cleanups.push(async () => await database.close())
    // Nothing dialled: the 2 s connect timeout would show here otherwise.
    expect(performance.now() - startedAt).toBeLessThan(500)
    await expect(database.query('SELECT 1')).rejects.toThrow()

    const jwks = await listen(
      createHttpServer((_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end('{"keys":[]}')
      })
    )
    cleanups.push(async () => await close(jwks))
    const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`
    const relay = createRelayServer(cellConfig(jwksUrl), database)
    const server = await listen(relay.server)
    cleanups.push(async () => await close(server))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect((await fetch(`${base}/ready`)).status).toBe(503)

    const proxy = await listenOn(
      createTcpServer((socket) => {
        const upstream = connect(Number(target.port), target.hostname)
        socket.pipe(upstream).pipe(socket)
        socket.on('error', () => upstream.destroy())
        upstream.on('error', () => socket.destroy())
      }),
      proxyPort
    )
    cleanups.push(async () => await close(proxy))
    const readiness = createRelayReadiness(database, jwksUrl, { cacheMs: 0 })
    await expect(readiness.check()).resolves.toBe(true)
  }, 20_000)
})

async function unusedPort(): Promise<number> {
  const probe = await listen(createTcpServer())
  const { port } = probe.address() as AddressInfo
  await close(probe)
  return port
}

async function listen<T extends Server | ReturnType<typeof createTcpServer>>(server: T): Promise<T> {
  return await listenOn(server, 0)
}

async function listenOn<T extends Server | ReturnType<typeof createTcpServer>>(
  server: T,
  port: number
): Promise<T> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

async function close(server: Server | ReturnType<typeof createTcpServer>): Promise<void> {
  if ('closeAllConnections' in server) server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function cellConfig(jwksUrl: string): RelayConfig {
  return {
    port: 0,
    publicUrl: 'https://c25.relay.example.test',
    cellUrl: 'https://c25.relay.example.test',
    region: 'asia-east2',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl,
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c25',
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
