import { describe, expect, it, vi } from 'vitest'
import type { LoginPreflightOutcome } from '../providers/macos-tcc-login-shell'
import { createNoopDaemonFileLog } from './daemon-file-log'
import {
  MacosLoginSessionDeathWatch,
  type MacosLoginSessionDeathWatchOptions
} from './macos-login-session-death-watch'
import type { SystemResolverHealth } from './types'

const ACCEPTED: LoginPreflightOutcome = { ok: true, conclusive: true, reason: 'accepted' }
const REJECTED: LoginPreflightOutcome = { ok: false, conclusive: true, reason: 'rejected' }
const INCONCLUSIVE: LoginPreflightOutcome = { ok: false, conclusive: false, reason: 'timeout' }

type FakeTimer = { at: number; callback: () => void; cleared: boolean }

class FakeClock {
  private timers: FakeTimer[] = []
  private nowMs = 0

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const timer: FakeTimer = { at: this.nowMs + delayMs, callback, cleared: false }
    this.timers.push(timer)
    return timer
  }

  clearTimeout = (handle: unknown): void => {
    ;(handle as FakeTimer).cleared = true
  }

  now = (): number => this.nowMs

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cleared && t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) {
        break
      }
      this.nowMs = due.at
      due.cleared = true
      due.callback()
      // Why: probes are async; let their promise chains settle before firing the next timer.
      await drainMicrotasks()
    }
    this.nowMs = target
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cleared).length
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

function createWatch(
  overrides: Partial<MacosLoginSessionDeathWatchOptions> & {
    outcomes?: (LoginPreflightOutcome | null)[]
  } = {}
): {
  watch: MacosLoginSessionDeathWatch
  clock: FakeClock
  onRetire: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
  setResolverHealth: (health: SystemResolverHealth) => void
} {
  const clock = new FakeClock()
  const onRetire = vi.fn()
  const outcomes = overrides.outcomes ?? []
  // Why length-check, not `??`: an explicit null outcome (wrapper not applicable) must reach the watch.
  const probe = vi.fn(async () => (outcomes.length ? outcomes.shift()! : ACCEPTED))
  let resolverHealth: SystemResolverHealth = 'unhealthy'
  const watch = new MacosLoginSessionDeathWatch({
    probeLoginSession: overrides.probeLoginSession ?? probe,
    readResolverHealth: overrides.readResolverHealth ?? (async () => resolverHealth),
    onRetire: overrides.onRetire ?? onRetire,
    log: overrides.log ?? createNoopDaemonFileLog(),
    clock,
    timing: {
      periodicProbeMs: 120_000,
      rejectionRecheckMs: 10_000,
      ptyExitDebounceMs: 2_000,
      clientActivityMinGapMs: 30_000,
      minProbeGapMs: 5_000,
      ...overrides.timing
    }
  })
  return {
    watch,
    clock,
    onRetire,
    probe,
    setResolverHealth: (health) => {
      resolverHealth = health
    }
  }
}

describe('MacosLoginSessionDeathWatch', () => {
  it('retires after consecutive conclusive rejections once armed, with a degraded resolver', async () => {
    const { watch, clock, onRetire } = createWatch({
      outcomes: [ACCEPTED, REJECTED, REJECTED, REJECTED]
    })
    watch.start()
    await drainMicrotasks()
    expect(onRetire).not.toHaveBeenCalled()

    await clock.advance(120_000) // periodic → rejection 1
    await clock.advance(10_000) // recheck → rejection 2
    expect(onRetire).not.toHaveBeenCalled()
    await clock.advance(10_000) // recheck → rejection 3 → retire
    expect(onRetire).toHaveBeenCalledWith({
      cause: 'pam-rejections',
      rejections: 3,
      resolverHealth: 'unhealthy'
    })
  })

  it('never retires when the session was never conclusively accepted', async () => {
    const { watch, clock, onRetire } = createWatch({
      outcomes: [REJECTED, REJECTED, REJECTED, REJECTED, REJECTED]
    })
    watch.start()
    await drainMicrotasks()
    for (let i = 0; i < 4; i++) {
      await clock.advance(120_000)
    }
    expect(onRetire).not.toHaveBeenCalled()
  })

  it('resets the rejection streak on a conclusive acceptance', async () => {
    const { watch, clock, onRetire } = createWatch({
      outcomes: [ACCEPTED, REJECTED, REJECTED, ACCEPTED, REJECTED, REJECTED]
    })
    watch.start()
    await drainMicrotasks()
    await clock.advance(120_000) // rejection 1
    await clock.advance(10_000) // rejection 2
    await clock.advance(10_000) // acceptance → reset
    await clock.advance(120_000) // rejection 1
    await clock.advance(10_000) // rejection 2
    expect(onRetire).not.toHaveBeenCalled()
  })

  it('keeps the rejection streak across interleaved inconclusive probes', async () => {
    const { watch, clock, onRetire } = createWatch({
      outcomes: [ACCEPTED, REJECTED, INCONCLUSIVE, REJECTED, INCONCLUSIVE, REJECTED]
    })
    watch.start()
    await drainMicrotasks()
    await clock.advance(120_000) // rejection 1
    await clock.advance(10_000) // inconclusive timeout — rejection streak holds
    await clock.advance(120_000) // rejection 2
    await clock.advance(10_000) // inconclusive
    await clock.advance(120_000) // rejection 3 → retire
    expect(onRetire).toHaveBeenCalledTimes(1)
    expect(onRetire.mock.calls[0][0].rejections).toBe(3)
    expect(onRetire.mock.calls[0][0].cause).toBe('pam-rejections')
  })

  it('keeps repeated inconclusive timeouts on the bounded periodic cadence', async () => {
    const readResolverHealth = vi.fn(async () => 'unhealthy' as const)
    const { watch, clock, onRetire, probe } = createWatch({
      outcomes: [ACCEPTED, ...Array.from({ length: 10 }, () => INCONCLUSIVE)],
      readResolverHealth
    })
    watch.start()
    await drainMicrotasks()
    for (let i = 0; i < 10; i++) {
      await clock.advance(120_000)
    }
    expect(probe).toHaveBeenCalledTimes(11)
    expect(readResolverHealth).not.toHaveBeenCalled()
    expect(onRetire).not.toHaveBeenCalled()
  })

  it.each(['healthy', 'unknown'] as const)(
    'suppresses retirement while resolver health is %s, then retires on explicit degradation',
    async (initialResolverHealth) => {
      const { watch, clock, onRetire, probe, setResolverHealth } = createWatch({
        outcomes: [ACCEPTED, REJECTED, REJECTED, REJECTED, REJECTED]
      })
      setResolverHealth(initialResolverHealth)
      watch.start()
      await drainMicrotasks()
      await clock.advance(120_000)
      await clock.advance(10_000)
      await clock.advance(10_000) // threshold reached but resolver did not corroborate death
      expect(onRetire).not.toHaveBeenCalled()
      const probesAtSuppression = probe.mock.calls.length
      setResolverHealth('unhealthy')
      await clock.advance(10_000)
      expect(probe).toHaveBeenCalledTimes(probesAtSuppression)
      await clock.advance(110_000) // suppressed states return to the bounded periodic cadence
      expect(onRetire).toHaveBeenCalledTimes(1)
    }
  )

  it('debounces a sustained PTY-exit burst into one trailing probe', async () => {
    const { watch, clock, probe } = createWatch({ outcomes: [ACCEPTED, ACCEPTED] })
    watch.start()
    await drainMicrotasks()
    await clock.advance(60_000)
    const before = probe.mock.calls.length
    watch.notifyPtyExit()
    await clock.advance(1_500)
    watch.notifyPtyExit()
    await clock.advance(1_500)
    watch.notifyPtyExit()
    await clock.advance(1_999)
    expect(probe).toHaveBeenCalledTimes(before)
    await clock.advance(1)
    expect(probe.mock.calls.length).toBe(before + 1)
  })

  it('probes on client activity only after the min gap', async () => {
    const { watch, clock, probe } = createWatch({
      outcomes: [ACCEPTED, ACCEPTED, ACCEPTED]
    })
    watch.start()
    await drainMicrotasks()
    const after = probe.mock.calls.length
    watch.notifyClientActivity() // too soon after startup probe, so retain one deferred probe
    await clock.advance(29_999)
    expect(probe.mock.calls.length).toBe(after)
    await clock.advance(1)
    expect(probe.mock.calls.length).toBe(after + 1)
  })

  it('defers a PTY-exit trigger that lands inside the global probe gap', async () => {
    const { watch, clock, probe } = createWatch({ outcomes: [ACCEPTED, ACCEPTED] })
    watch.start()
    await drainMicrotasks()

    watch.notifyPtyExit()
    await clock.advance(4_999)
    expect(probe).toHaveBeenCalledOnce()
    await clock.advance(1)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('retains one follow-up when a logout signal arrives during a probe', async () => {
    let resolveStartup!: (outcome: LoginPreflightOutcome) => void
    const startup = new Promise<LoginPreflightOutcome>((resolve) => {
      resolveStartup = resolve
    })
    const probe = vi
      .fn<MacosLoginSessionDeathWatchOptions['probeLoginSession']>()
      .mockReturnValueOnce(startup)
      .mockResolvedValue(ACCEPTED)
    const { watch, clock } = createWatch({ probeLoginSession: probe })
    watch.start()
    watch.notifyPtyExit()
    await clock.advance(2_000)
    expect(probe).toHaveBeenCalledOnce()

    resolveStartup(ACCEPTED)
    await drainMicrotasks()
    await clock.advance(2_999)
    expect(probe).toHaveBeenCalledOnce()
    await clock.advance(1)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('retains client activity that arrives during an armed periodic probe', async () => {
    let resolvePeriodic!: (outcome: LoginPreflightOutcome) => void
    const periodic = new Promise<LoginPreflightOutcome>((resolve) => {
      resolvePeriodic = resolve
    })
    const probe = vi
      .fn<MacosLoginSessionDeathWatchOptions['probeLoginSession']>()
      .mockResolvedValueOnce(ACCEPTED)
      .mockReturnValueOnce(periodic)
      .mockResolvedValue(ACCEPTED)
    const { watch, clock } = createWatch({ probeLoginSession: probe })
    watch.start()
    await drainMicrotasks()
    await clock.advance(120_000)

    watch.notifyClientActivity()
    resolvePeriodic(ACCEPTED)
    await drainMicrotasks()
    await clock.advance(29_999)
    expect(probe).toHaveBeenCalledTimes(2)
    await clock.advance(1)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('disables itself when the wrapper machinery does not apply', async () => {
    const { watch, clock, probe } = createWatch({ outcomes: [null] })
    watch.start()
    await drainMicrotasks()
    expect(probe).toHaveBeenCalledTimes(1)
    await clock.advance(600_000)
    watch.notifyPtyExit()
    watch.notifyClientActivity()
    await clock.advance(600_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels all pending timers', async () => {
    const { watch, clock } = createWatch({ outcomes: [ACCEPTED] })
    watch.start()
    await drainMicrotasks()
    watch.notifyPtyExit()
    watch.stop()
    expect(clock.pendingCount()).toBe(0)
  })

  it('stop() aborts an in-flight subprocess probe', async () => {
    let probeSignal: AbortSignal | undefined
    const probe = vi.fn((signal?: AbortSignal) => {
      probeSignal = signal
      return new Promise<LoginPreflightOutcome>(() => {})
    })
    const { watch } = createWatch({ probeLoginSession: probe })
    watch.start()
    expect(probeSignal?.aborted).toBe(false)

    watch.stop()

    expect(probeSignal?.aborted).toBe(true)
  })

  it('stop() prevents an in-flight resolver check from retiring the daemon', async () => {
    let resolveHealth!: (health: SystemResolverHealth) => void
    let resolverSignal: AbortSignal | undefined
    const resolverHealth = new Promise<SystemResolverHealth>((resolve) => {
      resolveHealth = resolve
    })
    const { watch, clock, onRetire } = createWatch({
      outcomes: [ACCEPTED, REJECTED, REJECTED, REJECTED],
      readResolverHealth: (signal) => {
        resolverSignal = signal
        return resolverHealth
      }
    })
    watch.start()
    await drainMicrotasks()
    await clock.advance(120_000)
    await clock.advance(10_000)
    await clock.advance(10_000) // retirement is now waiting on resolver health

    watch.stop()
    expect(resolverSignal?.aborted).toBe(true)
    resolveHealth('unhealthy')
    await drainMicrotasks()

    expect(onRetire).not.toHaveBeenCalled()
  })

  it('logs and reschedules when a probe throws instead of surfacing a rejection', async () => {
    const outcomes: (() => Promise<LoginPreflightOutcome>)[] = [
      async () => ACCEPTED,
      async () => {
        throw new Error('launchctl exploded')
      },
      async () => ACCEPTED
    ]
    const probe = vi.fn(() => (outcomes.shift() ?? (async () => ACCEPTED))())
    const { watch, clock, onRetire } = createWatch({ probeLoginSession: probe })
    watch.start()
    await drainMicrotasks()
    await clock.advance(120_000) // throwing probe
    await clock.advance(120_000) // rescheduled probe still runs
    expect(probe).toHaveBeenCalledTimes(3)
    expect(onRetire).not.toHaveBeenCalled()
  })
})
