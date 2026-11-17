import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteInstallTransport } from './remote-install-transport'
import type { InstallLockWait } from './remote-install-lock'

// A held install lock answered by command shape; its age follows the faked clock.
const lock = { createdAt: 0, stolen: false }
vi.mock('../../ssh/remote-exec/remote-host-exec', () => ({
  execHostCommand: async (_conn: unknown, _host: unknown, command: string) => {
    const ageSec = Math.floor((Date.now() - lock.createdAt) / 1000)
    if (command.includes('.steal')) {
      // Mirrors the host's rule: stale only once older than the threshold.
      lock.stolen = ageSec > 20 * 60
      return lock.stolen ? 'OK' : 'BUSY'
    }
    if (command.includes('echo "$age"')) {
      return `${ageSec}\n`
    }
    if (command.includes('if mkdir')) {
      return 'BUSY'
    }
    return ''
  }
}))

const { acquireInstallLock, RemoteInstallLockBusyError } = await import('./remote-install-lock')

// The mocked exec never reads the transport.
const conn: RemoteInstallTransport = Object.create(null)

async function settle(promise: Promise<void>, maxMs: number): Promise<'done' | Error> {
  let outcome: 'done' | Error | null = null
  promise.then(
    () => (outcome = 'done'),
    (error: Error) => (outcome = error)
  )
  for (let elapsed = 0; outcome === null && elapsed < maxMs; elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000)
  }
  return outcome ?? new Error('still waiting')
}

describe('acquireInstallLock waiting on a held lock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-16T06:44:00Z') })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    lock.stolen = false
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports when takeover becomes possible and waits for it past the step timeout', async () => {
    // A relaunch 1 minute after the lock was taken: the old 15-minute wait expired before takeover.
    lock.createdAt = Date.now() - 60_000
    const waits: InstallLockWait[] = []
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      onWait: (wait) => waits.push(wait)
    })
    expect(await settle(acquired, 25 * 60_000)).toBe('done')
    expect(lock.stolen).toBe(true)
    expect(waits[0]).toEqual({ takeoverInMs: 19 * 60_000, givesUpInMs: 20 * 60_000 })
    // Taken at the first recheck after the lock turned stale, about 20 minutes after it was made.
    expect(Date.now() - lock.createdAt).toBeLessThanOrEqual(21 * 60_000 + 1_000)
  })

  it('a relaunch takes over when the lock turns stale, not a full wait after it started', async () => {
    // Four minutes in: a fresh 15-minute wait would end a minute before the lock turns stale.
    lock.createdAt = Date.now() - 4 * 60_000
    const start = Date.now()
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true
    })
    expect(await settle(acquired, 25 * 60_000)).toBe('done')
    expect(Date.now() - start).toBeGreaterThan(15 * 60_000)
    expect(Date.now() - start).toBeLessThanOrEqual(17 * 60_000 + 1_000)
  })

  it('stops at the cap when a holder keeps refreshing the lock, and stops promising takeover', async () => {
    const start = Date.now()
    const refresh = setInterval(() => (lock.createdAt = Date.now()), 60_000)
    lock.createdAt = start
    const waits: InstallLockWait[] = []
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      onWait: (wait) => waits.push(wait)
    })
    try {
      expect(await settle(acquired, 30 * 60_000)).toBeInstanceOf(RemoteInstallLockBusyError)
      expect(Date.now() - start).toBeGreaterThan(20 * 60_000)
      expect(Date.now() - start).toBeLessThanOrEqual(22 * 60_000 + 1_000)
    } finally {
      clearInterval(refresh)
    }
    expect(waits[0]?.takeoverInMs).toBe(20 * 60_000)
    // Once takeover would land after the cap, the wait says when it gives up instead.
    const last = waits.at(-1)
    expect(last?.takeoverInMs).toBeNull()
    expect(last?.givesUpInMs).toBeLessThanOrEqual(60_000)
  })
})
