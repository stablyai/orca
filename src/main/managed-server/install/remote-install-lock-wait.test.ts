import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteInstallTransport } from './remote-install-transport'
import type { InstallLockWait } from './remote-install-lock'

// A held install lock answered by command shape; its age follows the faked clock.
const lock: {
  createdAt: number
  stolen: boolean
  holderGoneAt: number | null
  holderLive: boolean
  probes: number
  steals: string[]
} = {
  createdAt: 0,
  stolen: false,
  holderGoneAt: null,
  holderLive: false,
  probes: 0,
  steals: []
}
vi.mock('../../ssh/remote-exec/remote-host-exec', () => ({
  execHostCommand: async (_conn: unknown, _host: unknown, command: string) => {
    const ageSec = Math.floor((Date.now() - lock.createdAt) / 1000)
    const holderGone = lock.holderGoneAt !== null && Date.now() >= lock.holderGoneAt
    if (command.includes('echo HOLDER_EXITED_OK')) {
      lock.stolen = holderGone
      return holderGone ? 'HOLDER_EXITED_OK' : 'BUSY'
    }
    if (command.includes('echo "HOLDER_EXITED')) {
      lock.probes += 1
      if (lock.holderLive && !holderGone) {
        return 'HOLDER_LIVE\n'
      }
      return holderGone ? 'HOLDER_EXITED 1794874229:262443 t-dead\n' : ''
    }
    if (command.includes('.steal')) {
      lock.steals.push(command)
      // Mirrors the host's rule: stale once older than the threshold, unless a live holder vetoes.
      const vetoed = lock.holderLive && !holderGone && command.includes('holder_live')
      lock.stolen = ageSec > 20 * 60 && !vetoed
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
    lock.holderGoneAt = null
    lock.holderLive = false
    lock.probes = 0
    lock.steals = []
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
    lock.holderLive = true
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
    // While the holder runs, no age takeover is promised.
    expect(waits[0]?.takeoverInMs).toBeNull()
    expect(waits.at(-1)?.takeoverInMs).toBe(5_000)
  })

  it('never takes a lock by age while its holder still runs', async () => {
    lock.createdAt = Date.now() - 25 * 60_000
    lock.holderLive = true
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      waitThroughStaleTakeover: true,
      owner: { fileName: '.orca-fence-owner', token: 't-next' },
      probeExitedHolder: true
    })
    expect(await settle(acquired, 30 * 60_000)).toBeInstanceOf(RemoteInstallLockBusyError)
    expect(lock.stolen).toBe(false)
    expect(lock.steals.every((steal) => steal.includes('holder_live'))).toBe(true)
  })

  it('keeps the age rules, without the veto, when it does not probe holders', async () => {
    lock.createdAt = Date.now() - 25 * 60_000
    lock.holderLive = true
    const acquired = acquireInstallLock(conn, '/home/u/.orca-remote/orcad-1', undefined, {
      relayGcClaim: false,
      owner: { fileName: '.orca-fence-owner', token: 't-next' }
    })
    expect(await settle(acquired, 60_000)).toBe('done')
    expect(lock.steals[0]).not.toContain('holder_live')
  })
})
