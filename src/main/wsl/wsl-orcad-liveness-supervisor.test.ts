import { describe, expect, it, vi } from 'vitest'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { SystemPowerLifecycleListener } from '../system-power-lifecycle'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type { WslGuestIdentity } from './wsl-guest-process-identity'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { WSL_ORCAD_HEARTBEAT_MS } from './wsl-orcad-liveness-model'
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
        throw new Error('relaunch failed')
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
  const readIdentity = vi.fn(async () => state.identity)
  const collectCensus = vi.fn(async () => CENSUS)
  const ensureHolder = vi.fn(async () => {})
  const supervisor = new WslOrcadLivenessSupervisor({
    manager: {
      ensure,
      get: () => connection,
      publish: (_distro, status) => statuses.push(status),
      close: async () => {}
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
    readIdentity,
    collectCensus,
    ensureHolder,
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

  it('marks terminals exited and recovers when a user-visible distro is confirmed stopped', async () => {
    const h = harness({ visible: true })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: [] }
    h.lastWatch().exit(1)
    await h.advance(0)
    expect(h.statuses[0]).toEqual({
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: true
    })
    expect(h.readIdentity).toHaveBeenCalledTimes(1) // never exec'd into the stopped distro
    h.state.running = { status: 'confirmed', distros: ['Ubuntu'] }
    h.state.identity = { distroInstance: 'boot:2', orcad: 'orcad:101' }
    await h.advance(WSL_ORCAD_RECONNECT_DELAYS_MS[0] * 2)
    expect(h.ensure).toHaveBeenCalledTimes(2)
    expect(h.statuses.at(-1)).toEqual({ state: 'ready', census: CENSUS })
    expect(h.watches).toHaveLength(2)
  })

  it('never boots a stopped distro for background work; the gate resumes it once running', async () => {
    const h = harness({ visible: false })
    await h.supervisor.connect('Ubuntu')
    h.state.running = { status: 'confirmed', distros: [] }
    h.lastWatch().exit(1)
    await h.advance(60_000)
    expect(h.statuses).toEqual([
      { state: 'distro-stopped', terminals: 'exited', recovering: false }
    ])
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(h.ensureHolder).not.toHaveBeenCalled()
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
    await expect(h.supervisor.connect('Ubuntu', { force: true })).rejects.toThrow('relaunch failed')
    expect(h.ensure).toHaveBeenLastCalledWith('Ubuntu', { force: true })
    expect(h.watches).toHaveLength(2)
    expect(h.lastWatch().closed).toBe(false)
  })

  it('reports ready itself when a user connect supersedes a recovery', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    h.lastWatch().exit(0)
    await h.settle()
    expect(h.statuses.at(-1)).toMatchObject({ state: 'reconnecting' })
    await h.supervisor.connect('Ubuntu')
    expect(h.statuses.at(-1)).toEqual({ state: 'ready', census: null })
  })

  it('leaves an orcad nobody uses stopped instead of undoing its idle exit', async () => {
    const h = harness({ visible: false })
    await h.supervisor.connect('Ubuntu')
    h.state.identity = { distroInstance: 'boot:1', orcad: null }
    h.lastWatch().exit(0)
    await h.advance(60_000)
    expect(h.statuses).toEqual([{ state: 'idle', terminals: 'unverifiable' }])
    expect(h.ensure).toHaveBeenCalledTimes(1)
  })

  it('reattaches the watch when orcad is still the same process', async () => {
    const h = harness()
    await h.supervisor.connect('Ubuntu')
    h.lastWatch().exit(0)
    await h.advance(0)
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
