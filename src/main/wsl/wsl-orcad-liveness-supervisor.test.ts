import { describe, expect, it, vi } from 'vitest'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { SystemPowerLifecycleListener } from '../system-power-lifecycle'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type { WslGuestIdentity } from './wsl-guest-process-identity'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { EXIT_SETTLE_MS } from './wsl-orcad-liveness-evidence'
import { WSL_ORCAD_HEARTBEAT_MS } from './wsl-orcad-liveness-state'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'
import { WSL_ORCAD_RECONNECT_DELAYS_MS } from './wsl-orcad-reconnect-backoff'
import type { WslOrcadWatch } from './wsl-orcad-watch'

const CENSUS: OrcadTerminalCensus = {
  liveSessions: 2,
  startedSinceActivation: 2,
  daemonProtocolVersion: 3
}

function harness(options: { visible?: boolean } = {}) {
  let clock = 0
  const timers: { at: number; task: () => void; cancelled: boolean }[] = []
  let pid = 100
  let connection: WslOrcadConnection | null = null
  const statuses: WslOrcadConnectionStatus[] = []
  const watches: { exit: (code: number | null) => void; closed: boolean }[] = []
  const state: {
    visible: boolean
    running: WslRunningDistrosRead
    identity: WslGuestIdentity | null
    watchSignal: WslOrcadWatch['signal']
    ensureFails: number
    ensureError?: Error
  } = {
    visible: options.visible ?? true,
    running: { status: 'confirmed', distros: ['Ubuntu'] },
    identity: { distroInstance: 'boot:1', orcad: 'orcad:100' },
    watchSignal: 'ready',
    ensureFails: 0
  }
  const deferred: (() => unknown)[] = []
  let power: SystemPowerLifecycleListener | null = null
  const ensure = vi.fn(
    async (
      distro: string,
      opts?: { status?: { pending: WslOrcadConnectionStatus; ready: WslOrcadConnectionStatus } }
    ) => {
      if (opts?.status) {
        statuses.push(opts.status.pending)
      }
      if (state.ensureFails > 0) {
        state.ensureFails -= 1
        throw state.ensureError ?? new Error('relaunch failed')
      }
      connection = {
        distro,
        environmentId: 'wsl:ubuntu',
        localPort: 7000,
        remotePort: 6768,
        fullVersion: '1',
        pid: pid++,
        pairingOffer: 'offer',
        deferredUpdate: null,
        close: async () => {}
      }
      if (opts?.status) {
        statuses.push(opts.status.ready)
      }
      return connection
    }
  )
  const readRunning = vi.fn(async () => state.running)
  const requireRunning = vi.fn(async (_distro: string) => true)
  const readIdentity = vi.fn(async () => state.identity)
  const collectCensus = vi.fn(async () => CENSUS)
  const ensureHolder = vi.fn(async () => {})
  const retireListener = vi.fn(async () => {
    connection = null
  })
  const supervisor = new WslOrcadLivenessSupervisor({
    manager: {
      ensure,
      get: () => connection,
      publish: (_distro, status) => statuses.push(status),
      close: async () => {},
      retireListener
    },
    readRunning,
    readIdentity,
    openWatch: async () => {
      if (state.watchSignal !== 'ready') {
        return { signal: state.watchSignal, onExit: () => {}, close: () => {} }
      }
      const record = { exit: (_code: number | null) => {}, closed: false }
      watches.push(record)
      return {
        signal: 'ready',
        onExit: (listener) => {
          record.exit = listener
        },
        close: () => {
          record.closed = true
        }
      }
    },
    collectCensus,
    hasUserVisibleWork: () => state.visible,
    deferUntilRunning: (_distro, _key, task) => deferred.push(task),
    requireRunning,
    ensureHolder,
    subscribePower: (listener) => {
      power = listener
      listener.onResume()
      return () => {
        power = null
      }
    },
    monotonicNow: () => clock,
    schedule: (delayMs, task) => {
      const timer = { at: clock + delayMs, task, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    },
    random: () => 0
  })

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** Advances monotonic time, firing due timers in order. */
  async function advance(ms: number): Promise<void> {
    const target = clock + ms
    for (;;) {
      await settle()
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) {
        break
      }
      clock = Math.max(clock, due.at)
      due.cancelled = true
      due.task()
    }
    clock = target
    await settle()
  }

  return {
    supervisor,
    state,
    statuses,
    watches,
    deferred,
    ensure,
    readRunning,
    requireRunning,
    readIdentity,
    collectCensus,
    ensureHolder,
    retireListener,
    advance,
    settle,
    power: () => power,
    jumpClock: (ms: number) => {
      clock += ms
    },
    lastWatch: () => watches.at(-1)!
  }
}

describe('WslOrcadLivenessSupervisor', () => {
  it('connects, records identity and holds one watch', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    expect(h.readIdentity).toHaveBeenCalledWith('Ubuntu', 100)
    expect(h.watches).toHaveLength(1)
  })

  it('keeps a confirmed-stopped distro down even with visible work, until it runs again (E9)', async () => {
    const h = harness({ visible: true })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: [] }
    h.lastWatch().exit(1)
    await h.advance(60_000)
    expect(h.statuses).toEqual([
      { state: 'distro-stopped', terminals: 'exited', recovering: false }
    ])
    expect(h.readIdentity).toHaveBeenCalledTimes(1) // never exec'd into the stopped distro
    expect(h.ensure).toHaveBeenCalledTimes(1)
    // Parked with visible work too: a dial to a kept listener would boot the distro.
    expect(h.retireListener).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    expect(h.deferred).toHaveLength(1)
    // Started by someone else: relaunch into the running distro.
    h.state.running = { status: 'confirmed', distros: ['Ubuntu'] }
    h.state.identity = { distroInstance: 'boot:2', orcad: 'orcad:101' }
    h.deferred[0]()
    await h.advance(5_000)
    expect(h.ensure).toHaveBeenCalledTimes(2)
    expect(h.statuses.at(-1)).toEqual({ state: 'ready', census: CENSUS })
  })

  it('reports settling right after an exit, while the running list may be stale (E9)', async () => {
    const h = harness({ visible: true })
    await h.supervisor.connect('Ubuntu')
    expect(h.supervisor.isSettling('Ubuntu')).toBe(false)
    // WSL still lists the stopping distro as running.
    h.state.running = { status: 'confirmed', distros: ['Ubuntu'] }
    h.lastWatch().exit(1)
    expect(h.supervisor.isSettling('Ubuntu')).toBe(true)
    h.state.running = { status: 'confirmed', distros: [] }
    await h.advance(60_000)
    expect(h.statuses.at(-1)).toMatchObject({ state: 'distro-stopped' })
    expect(h.supervisor.isSettling('Ubuntu')).toBe(false)
  })

  it('re-verifies after a no-boot connect is refused, so the distro still gets a verdict (E9)', async () => {
    const h = harness({ visible: true })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: [] }
    h.state.ensureFails = 1
    h.state.ensureError = new WslDistroNotRunningError('Ubuntu')
    await expect(h.supervisor.connect('Ubuntu', { noBoot: true })).rejects.toBeInstanceOf(
      WslDistroNotRunningError
    )
    await h.advance(60_000)
    expect(h.statuses.at(-1)).toMatchObject({ state: 'distro-stopped' })
  })

  it('reports settling after a clean exit too (code 0 from wsl --shutdown)', async () => {
    const h = harness({ visible: true })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: ['Ubuntu'] }
    h.lastWatch().exit(0)
    // Past the verdict pass (settle and re-read), the window after the exit still holds.
    await h.advance(1_000)
    expect(h.supervisor.isSettling('Ubuntu')).toBe(true)
    await h.advance(10_000)
    expect(h.supervisor.isSettling('Ubuntu')).toBe(false)
  })

  it('settles a clean exit before reading identity, so a stale list cannot boot the distro', async () => {
    const h = harness({ visible: true })
    await h.supervisor.connect('Ubuntu')
    const identityReads = h.readIdentity.mock.calls.length
    // wsl --shutdown ends the watch cleanly while WSL still lists the distro for a moment.
    h.state.running = { status: 'confirmed', distros: [] }
    h.readRunning.mockResolvedValueOnce({ status: 'confirmed', distros: ['Ubuntu'] })
    h.lastWatch().exit(0)
    await h.advance(60_000)
    expect(h.statuses.at(-1)).toMatchObject({ state: 'distro-stopped' })
    // Never exec'd into the stopping distro.
    expect(h.readIdentity).toHaveBeenCalledTimes(identityReads)
  })

  it('re-ensures the holder once a connect is armed', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    // An earlier orcad's idle release may have ended the holder the launch adopted.
    expect(h.ensureHolder).toHaveBeenCalledExactlyOnceWith('Ubuntu')
  })

  it('never boots a stopped distro for background work; the gate resumes it once running', async () => {
    const h = harness({ visible: false })
    await h.supervisor.connect('Ubuntu')
    h.ensureHolder.mockClear()
    h.state.running = { status: 'confirmed', distros: [] }
    h.lastWatch().exit(1)
    await h.advance(60_000)
    expect(h.statuses).toEqual([
      { state: 'distro-stopped', terminals: 'exited', recovering: false }
    ])
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(h.ensureHolder).not.toHaveBeenCalled()
    // A dial to a kept listener would spawn wsl.exe and boot the stopped distro.
    expect(h.retireListener).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    expect(h.deferred).toHaveLength(1)
    // The user started it some other way: the distro restarted, so relaunch into it.
    h.state.running = { status: 'confirmed', distros: ['Ubuntu'] }
    h.state.identity = { distroInstance: 'boot:2', orcad: null }
    h.deferred[0]()
    await h.advance(5_000)
    expect(h.ensure).toHaveBeenCalledTimes(2)
    expect(h.statuses.at(-1)).toEqual({ state: 'ready', census: CENSUS })
  })

  it('relaunches a crashed orcad and runs the census before reporting ready', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    h.lastWatch().exit(0)
    await h.advance(5_000)
    const states = h.statuses.map((status) =>
      status.state === 'reconnecting' ? `${status.state}:${status.reason}` : status.state
    )
    expect(states).toEqual([
      'reconnecting:orcad-exited',
      'reconnecting:orcad-exited',
      'reconnecting:census',
      'ready'
    ])
    expect(h.statuses[0]).toMatchObject({ terminals: 'unverifiable' })
    expect(h.collectCensus).toHaveBeenCalledTimes(1)
  })

  it('keeps watching the incumbent when an update connect fails', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.state.ensureFails = 1
    await expect(h.supervisor.connect('Ubuntu', { intent: 'force' })).rejects.toThrow(
      'relaunch failed'
    )
    expect(h.ensure).toHaveBeenLastCalledWith('Ubuntu', { intent: 'force' })
    expect(h.watches).toHaveLength(2)
    expect(h.lastWatch().closed).toBe(false)
  })

  it('recovery reconnects only into a distro it confirms running right before spawning (E9)', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    h.lastWatch().exit(1)
    await h.advance(60_000)
    const recoveryCalls = h.ensure.mock.calls.slice(1)
    expect(recoveryCalls.length).toBeGreaterThan(0)
    for (const [, opts] of recoveryCalls) {
      expect(opts).toMatchObject({ requireRunning: h.requireRunning })
    }
  })

  it('reports ready itself when a user connect supersedes a recovery', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    h.lastWatch().exit(0)
    // A clean exit is settled (and the list re-read) before the verdict, as a failed one is.
    await h.advance(EXIT_SETTLE_MS)
    expect(h.statuses.at(-1)).toMatchObject({ state: 'reconnecting' })
    await h.supervisor.connect('Ubuntu')
    expect(h.statuses.at(-1)).toEqual({ state: 'ready', census: null })
  })

  it('never reports ready or holds the distro on a wake after the listener was retired', async () => {
    const h = harness({ visible: false })
    // No pid file at arm: the port is the only liveness evidence.
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    await h.supervisor.connect('Ubuntu')
    h.state.watchSignal = 'refused'
    h.lastWatch().exit(0)
    await h.advance(60_000)
    expect(h.retireListener).toHaveBeenCalledOnce()
    // Before the fix, a missing connection read as a port that answered.
    h.state.watchSignal = 'ready'
    const holds = h.ensureHolder.mock.calls.length
    h.power()?.onResume()
    await h.advance(60_000)
    expect(h.statuses.filter((status) => status.state === 'ready')).toEqual([])
    expect(h.ensureHolder).toHaveBeenCalledTimes(holds)
    expect(h.ensure).toHaveBeenCalledTimes(1)
  })

  it('leaves an orcad nobody uses stopped instead of undoing its idle exit', async () => {
    const h = harness({ visible: false })
    await h.supervisor.connect('Ubuntu')
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    h.lastWatch().exit(0)
    await h.advance(60_000)
    expect(h.statuses).toEqual([{ state: 'idle', terminals: 'unverifiable' }])
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(h.retireListener).toHaveBeenCalledExactlyOnceWith('Ubuntu')
  })

  it('reattaches the watch when orcad is still the same process', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.lastWatch().exit(0)
    await h.advance(EXIT_SETTLE_MS)
    expect(h.statuses).toEqual([])
    expect(h.watches).toHaveLength(2)
    expect(h.ensure).toHaveBeenCalledTimes(1)
  })

  it('reports unverifiable, never exited, when the running list cannot be read, and keeps looking', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'unavailable' }
    h.lastWatch().exit(1)
    await h.advance(0)
    expect(h.statuses).toEqual([
      { state: 'unverifiable', reason: 'running-list-unavailable', terminals: 'unverifiable' }
    ])
    await h.advance(120_000)
    expect(h.statuses.every((status) => status.state === 'unverifiable')).toBe(true)
    expect(h.ensure).toHaveBeenCalledTimes(1)
    const reads = h.readRunning.mock.calls.length
    expect(reads).toBeGreaterThan(3)
    h.state.running = { status: 'confirmed', distros: ['Ubuntu'] }
    await h.advance(30_000)
    expect(h.statuses.at(-1)).toEqual({ state: 'ready', census: null })
  })

  it('waits for a still-listed distro to settle after a failed exit before probing inside it', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.lastWatch().exit(1)
    await h.settle()
    expect(h.readRunning).toHaveBeenCalledTimes(1)
    h.state.running = { status: 'confirmed', distros: [] }
    await h.advance(500)
    expect(h.readIdentity).toHaveBeenCalledTimes(1)
    expect(h.statuses[0]).toMatchObject({ state: 'distro-stopped' })
  })

  it('gives up after the bounded ladder and says so', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    h.state.ensureFails = 100
    h.lastWatch().exit(0)
    await h.advance(10 * 60_000)
    expect(h.ensure).toHaveBeenCalledTimes(1 + WSL_ORCAD_RECONNECT_DELAYS_MS.length)
    expect(h.statuses.at(-1)).toMatchObject({ state: 'failed', terminals: 'unverifiable' })
  })

  it('re-verifies on power resume instead of trusting its timers, but not on subscribe', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    expect(h.readRunning).not.toHaveBeenCalled()
    h.power()?.onSuspend()
    await h.advance(WSL_ORCAD_HEARTBEAT_MS * 3)
    expect(h.readRunning).not.toHaveBeenCalled()
    h.state.identity = { distroInstance: 'boot:9', orcad: null }
    h.power()?.onResume()
    await h.advance(0)
    expect(h.readIdentity).toHaveBeenCalledTimes(2)
    expect(h.statuses[0]).toMatchObject({ state: 'reconnecting', reason: 'distro-restarted' })
  })

  it('heartbeats with the running list only, and re-ensures the holder while running', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    await h.advance(WSL_ORCAD_HEARTBEAT_MS)
    expect(h.readRunning).toHaveBeenCalledTimes(1)
    expect(h.readIdentity).toHaveBeenCalledTimes(1)
    expect(h.ensureHolder).toHaveBeenCalledWith('Ubuntu')
  })

  it('treats a heartbeat far past due as a pause and verifies fully', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.jumpClock(WSL_ORCAD_HEARTBEAT_MS * 5)
    await h.advance(0)
    expect(h.readIdentity).toHaveBeenCalledTimes(2)
  })

  it('ignores wall-clock jumps entirely', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 7 * 24 * 3_600_000)
      await h.advance(1_000)
      vi.setSystemTime(Date.now() - 30 * 24 * 3_600_000)
      await h.advance(1_000)
    } finally {
      vi.useRealTimers()
    }
    expect(h.readRunning).not.toHaveBeenCalled()
    expect(h.statuses).toEqual([])
  })

  it('stops supervising on stop, closing the watch and ignoring late exits', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    const watch = h.lastWatch()
    await h.supervisor.stop('Ubuntu')
    expect(watch.closed).toBe(true)
    watch.exit(1)
    await h.advance(60_000)
    expect(h.readRunning).not.toHaveBeenCalled()
  })

  it('treats a holder exit like a bridge exit', async () => {
    const h = harness({ visible: false })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: [] }
    h.supervisor.noteHolderExit('UBUNTU', { code: 1 })
    await h.advance(0)
    expect(h.statuses[0]).toMatchObject({ state: 'distro-stopped', terminals: 'exited' })
  })

  it('lets a user connect supersede the deferred re-check of a stopped distro', async () => {
    const h = harness({ visible: false })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: [] }
    h.lastWatch().exit(1)
    await h.advance(1_000)
    h.state.running = { status: 'confirmed', distros: ['Ubuntu'] }
    h.state.identity = { distroInstance: 'boot:2', orcad: 'orcad:101' }
    await h.supervisor.connect('Ubuntu')
    h.deferred[0]()
    await h.advance(5_000)
    expect(h.ensure).toHaveBeenCalledTimes(2)
    expect(h.statuses.map((status) => status.state)).toEqual(['distro-stopped', 'ready'])
  })

  it('reports a stop once when both the holder and the watch exit', async () => {
    const h = harness({ visible: false })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: [] }
    h.supervisor.noteHolderExit('Ubuntu', { code: 1 })
    h.lastWatch().exit(1)
    await h.advance(1_000)
    expect(h.statuses.map((status) => status.state)).toEqual(['distro-stopped'])
  })
})
