import { describe, expect, it, vi } from 'vitest'
import type { OrcadTerminalCensus } from '../../../shared/orcad-terminal-census'
import type { SystemPowerLifecycleListener } from '../../power/system-power-lifecycle'
import type { WslRunningDistrosRead } from '../discovery/wsl-background-distro-gate'
import type { WslGuestIdentity } from '../execution/wsl-guest-process-identity'
import type { WslOrcadConnection } from './wsl-orcad-connection-types'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { WslOrcadLivenessSupervisor } from './wsl-orcad-liveness-supervisor'
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
  const watches: { exit: (code: number | null) => void; idle: () => void; closed: boolean }[] = []
  const state: {
    visible: boolean
    running: WslRunningDistrosRead
    identity: WslGuestIdentity | null
    watchSignal: WslOrcadWatch['signal']
    watchProves: boolean
    ensureFails: number
    ensureError?: Error
  } = {
    visible: options.visible ?? true,
    running: { status: 'confirmed', distros: ['Ubuntu'] },
    identity: { distroInstance: 'boot:1', orcad: 'orcad:100' },
    watchSignal: 'ready',
    watchProves: true,
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
  const readRunning = vi.fn(
    async (_target: { distro: string; exitedAt?: number | null }) => state.running
  )
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
        return {
          signal: state.watchSignal,
          onExit: () => {},
          close: () => {},
          proving: () => false
        }
      }
      const record = { exit: (_code: number | null) => {}, idle: () => {}, closed: false }
      watches.push(record)
      return {
        signal: 'ready',
        onExit: (listener) => {
          record.exit = listener
        },
        onIdle: (listener) => {
          record.idle = listener
        },
        close: () => {
          record.closed = true
        },
        proving: () => !record.closed && state.watchProves
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
    clock: () => clock,
    lastWatch: () => watches.at(-1)!,
    watchCount: () => watches.length
  }
}

describe('WslOrcadLivenessSupervisor', () => {
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
})
