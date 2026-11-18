import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteInstallTransport } from './remote-install-transport'
import type { InstallLockWait } from './remote-install-lock'

// A held install lock answered by command shape; its age follows the faked clock.
const lock: {
  createdAt: number
  stolen: boolean
  holderGoneAt: number | null
  holderBackAt: number | null
  probes: number
  loseStealReply: boolean
} = {
  createdAt: 0,
  stolen: false,
  holderGoneAt: null,
  holderBackAt: null,
  probes: 0,
  loseStealReply: false
}
vi.mock('../../ssh/remote-exec/remote-host-exec', () => ({
  execHostCommand: async (_conn: unknown, _host: unknown, command: string) => {
    const ageSec = Math.floor((Date.now() - lock.createdAt) / 1000)
    const holderGone =
      lock.holderGoneAt !== null &&
      Date.now() >= lock.holderGoneAt &&
      (lock.holderBackAt === null || Date.now() < lock.holderBackAt)
    if (command.includes('echo HOLDER_EXITED_OK')) {
      lock.stolen = holderGone
      if (lock.loseStealReply) {
        throw new Error('wsl.exe closed before answering')
      }
      return holderGone ? 'HOLDER_EXITED_OK' : 'BUSY'
    }
    if (command.includes('echo OWNED')) {
      return lock.stolen ? 'OWNED\n' : 'NOT_OWNED\n'
    }
    if (command.includes('echo "HOLDER_EXITED')) {
      lock.probes += 1
      return holderGone ? 'HOLDER_EXITED 1794874229:262443 t-dead\n' : ''
    }
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

const { acquireInstallLock } = await import('./remote-install-lock')

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
    lock.holderGoneAt = null
    lock.holderBackAt = null
    lock.loseStealReply = false
    lock.probes = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('takes over a fresh flock-backed lock seconds after its holder is seen gone twice', async () => {
    lock.createdAt = Date.now() - 60_000
    lock.holderGoneAt = Date.now() + 30_000
    const start = Date.now()
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      owner: { fileName: '.orca-fence-owner', token: 't-next' },
      probeExitedHolder: true
    })
    expect(await settle(acquired, 2 * 60_000)).toBe('done')
    expect(lock.stolen).toBe(true)
    // First gone reading at 30s, confirmed by the next probe 5s later.
    expect(Date.now() - start).toBeGreaterThanOrEqual(35_000)
    expect(Date.now() - start).toBeLessThanOrEqual(41_000)
  })

  it('treats a takeover whose reply was lost as acquired once the lock names its token', async () => {
    lock.createdAt = Date.now() - 60_000
    lock.holderGoneAt = Date.now()
    lock.loseStealReply = true
    const start = Date.now()
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      owner: { fileName: '.orca-fence-owner', token: 't-next' },
      probeExitedHolder: true
    })
    expect(await settle(acquired, 60_000)).toBe('done')
    expect(lock.stolen).toBe(true)
    // Not the 20-minute age rule: the next probe finds the lock already ours.
    expect(Date.now() - start).toBeLessThanOrEqual(16_000)
  })

  it('never probes without an owner token to bind the proof to', async () => {
    lock.createdAt = Date.now() - 19 * 60_000
    lock.holderGoneAt = Date.now()
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      probeExitedHolder: true
    })
    expect(await settle(acquired, 5 * 60_000)).toBe('done')
    expect(lock.probes).toBe(0)
  })

  it('reports a takeover in seconds, not the age countdown, once a holder reads gone', async () => {
    lock.createdAt = Date.now() - 60_000
    lock.holderGoneAt = Date.now() + 90_000
    const waits: InstallLockWait[] = []
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      owner: { fileName: '.orca-fence-owner', token: 't-next' },
      probeExitedHolder: true,
      onWait: (wait) => waits.push(wait)
    })
    expect(await settle(acquired, 3 * 60_000)).toBe('done')
    // While the holder runs, the age countdown stands; once it reads gone, seconds.
    expect(waits[0]).toEqual({ takeoverInMs: 19 * 60_000, givesUpInMs: 20 * 60_000 })
    expect(waits.at(-1)).toMatchObject({ takeoverInMs: 5_000, holderGone: true })
  })

  it('returns to the age countdown at the next probe when a holder no longer reads gone', async () => {
    lock.createdAt = Date.now() - 60_000
    // One gone reading, never confirmed by a second.
    lock.holderGoneAt = Date.now() + 10_000
    lock.holderBackAt = Date.now() + 12_000
    const waits: { wait: InstallLockWait; at: number }[] = []
    const start = Date.now()
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      owner: { fileName: '.orca-fence-owner', token: 't-next' },
      probeExitedHolder: true,
      onWait: (wait) => waits.push({ wait, at: Date.now() - start })
    })
    expect(await settle(acquired, 30_000)).toEqual(new Error('still waiting'))
    expect(waits.map(({ wait }) => wait.holderGone === true)).toEqual([false, true, false])
    // The flip back is reported at the next probe, not the next 60 s recheck.
    expect(waits[2]?.at).toBeLessThan(20_000)
    expect(waits[2]?.wait.takeoverInMs).toBeGreaterThan(18 * 60_000)
  })
})
