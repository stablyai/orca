import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRelayDatabaseTransientError, openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// A Cloud SQL instance that is starting has an IP but never answers. The 2026-10-11 staging stall
// came from the transport blocking connect() itself, which no test can reproduce; these pin what
// the pool must do over a transport that does not block: fail fast and keep the event loop turning.
type StallingDatabase = {
  port: number
  // 'forward' needs a real PostgreSQL behind it.
  mode: 'blackhole' | 'refuse' | 'forward'
  sockets: Set<Socket>
  server: Server
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

describe('PostgreSQL pool over a database that accepts and never answers', () => {
  it('fails every caller fast and retryably without stalling the event loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stalling = await stallingDatabase('blackhole')
    const database = await openStallingPool(stalling, 'postgresql://relay:secret@127.0.0.1')
    const loop = watchEventLoop()

    // Twice the pool: three dial, three queue behind them in the general lane.
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const startedAt = performance.now()
        const error = await database.query('SELECT 1').catch((failure: unknown) => failure)
        return { error, elapsedMs: performance.now() - startedAt }
      })
    )

    const gapMs = loop.stop()
    for (const { error, elapsedMs } of outcomes) {
      expect(isRelayDatabaseTransientError(error)).toBe(true)
      // A queued caller waits out one connect timeout for a slot, then one for its own dial.
      expect(elapsedMs).toBeLessThan(4_500)
    }
    expect(stalling.sockets.size).toBeGreaterThan(0)
    expect(gapMs).toBeLessThan(250)
  }, 15_000)
})

describePostgres('PostgreSQL pool through a database stop and start', () => {
  it('fails fast while the database is down or starting, then serves again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stalling = await stallingDatabase('forward')
    const database = await openStallingPool(stalling, databaseUrl!)
    const loop = watchEventLoop()
    expect(await database.query('SELECT 1 AS up')).toEqual([{ up: 1 }])

    // Stopped: the instance refuses connections, and every pooled client is gone with it.
    stalling.mode = 'refuse'
    dropConnections(stalling)
    await expectFastTransientFailure(database, 1_000)

    // Starting: the address answers TCP but PostgreSQL never speaks.
    stalling.mode = 'blackhole'
    await expectFastTransientFailure(database, 2_500)

    stalling.mode = 'forward'
    dropConnections(stalling)
    // The first caller after the start may still draw a client from the starting phase.
    await expect.poll(async () => await database.query('SELECT 1 AS up').catch(() => []), {
      timeout: 10_000,
      interval: 100
    }).toEqual([{ up: 1 }])
    expect(await database.query('SELECT 2 AS up')).toEqual([{ up: 2 }])
    expect(loop.stop()).toBeLessThan(250)
  }, 30_000)
})

async function expectFastTransientFailure(database: RelayDatabase, boundMs: number): Promise<void> {
  const startedAt = performance.now()
  const error = await database.query('SELECT 1').catch((failure: unknown) => failure)
  expect(isRelayDatabaseTransientError(error)).toBe(true)
  expect(performance.now() - startedAt).toBeLessThan(boundMs)
}

async function openStallingPool(stalling: StallingDatabase, url: string): Promise<RelayDatabase> {
  const viaStall = new URL(url)
  viaStall.hostname = '127.0.0.1'
  viaStall.port = String(stalling.port)
  if (!viaStall.pathname || viaStall.pathname === '/') viaStall.pathname = '/relay'
  const database = await openRelayDatabase({
    databaseUrl: viaStall.toString(),
    dataDir: '',
    poolMax: 3,
    appliesPostgresSchema: false
  })
  cleanups.push(async () => await database.close().catch(() => undefined))
  return database
}

async function stallingDatabase(mode: StallingDatabase['mode']): Promise<StallingDatabase> {
  const target = databaseUrl ? new URL(databaseUrl) : undefined
  const sockets = new Set<Socket>()
  const stalling: StallingDatabase = { port: 0, mode, sockets, server: createTcpServer() }
  stalling.server.on('connection', (socket) => {
    if (stalling.mode === 'refuse') {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    if (stalling.mode === 'blackhole' || !target) return
    const upstream = connect(Number(target.port || 5432), target.hostname)
    socket.pipe(upstream).pipe(socket)
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => stalling.server.listen(0, '127.0.0.1', resolve))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a TCP server listening on a host and port reports an AddressInfo, never a pipe path.
  stalling.port = (stalling.server.address() as AddressInfo).port
  cleanups.push(async () => {
    dropConnections(stalling)
    await new Promise<void>((resolve) => stalling.server.close(() => resolve()))
  })
  return stalling
}

function dropConnections(stalling: StallingDatabase): void {
  for (const socket of stalling.sockets) socket.destroy()
  stalling.sockets.clear()
}

// The longest gap between 10 ms ticks: a blocked loop shows as one long gap.
function watchEventLoop(): { stop: () => number } {
  let last = performance.now()
  let longestGapMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longestGapMs = Math.max(longestGapMs, now - last)
    last = now
  }, 10)
  return {
    stop: () => {
      clearInterval(timer)
      return longestGapMs
    }
  }
}
