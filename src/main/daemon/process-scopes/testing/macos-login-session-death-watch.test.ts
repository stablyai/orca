import { describe, expect, it, vi } from 'vitest'
import type { LoginPreflightOutcome } from '../../../providers/macos-tcc-login-shell'
import { createNoopDaemonFileLog } from '../../observability/daemon-file-log'
import {
  MacosLoginSessionDeathWatch,
  type MacosLoginSessionDeathWatchOptions
} from '../macos-login-session-death-watch'
import type { SystemResolverHealth } from '../../protocol/daemon-rpc-contract'

const ACCEPTED: LoginPreflightOutcome = { ok: true, conclusive: true, reason: 'accepted' }
const REJECTED: LoginPreflightOutcome = { ok: false, conclusive: true, reason: 'rejected' }

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
      this.nowMs = Math.max(this.nowMs, due.at)
      due.cleared = true
      due.callback()
      // Settle async probes before advancing to the next timer.
      await drainMicrotasks()
    }
    this.nowMs = target
  }

  suspend(ms: number): void {
    this.nowMs += ms
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
  // Preserve explicit null outcomes that disable the watch.
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
      minimumRejectionSpanMs: 120_000,
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
  it('preserves the daemon when a short PAM rejection burst recovers after wake', async () => {
    const { watch, clock, onRetire, probe } = createWatch({
      outcomes: [ACCEPTED, REJECTED, REJECTED, REJECTED, ACCEPTED]
    })
    watch.start()
    await drainMicrotasks()

    await clock.advance(120_000)
    await clock.advance(10_000)
    await clock.advance(10_000)

    expect(probe).toHaveBeenCalledTimes(4)
    expect(onRetire).not.toHaveBeenCalled()

    watch.notifyClientActivity()
    watch.notifyPtyExit()
    await clock.advance(99_999)
    expect(probe).toHaveBeenCalledTimes(4)
    await clock.advance(1)
    expect(probe).toHaveBeenCalledTimes(5)
    expect(onRetire).not.toHaveBeenCalled()
  })

  it('does not count a suspended timer gap as rejection evidence', async () => {
    const { watch, clock, onRetire, probe } = createWatch({
      outcomes: [ACCEPTED, REJECTED, REJECTED, ACCEPTED]
    })
    watch.start()
    await drainMicrotasks()

    await clock.advance(120_000)
    clock.suspend(60 * 60 * 1000)
    await clock.advance(0)

    expect(probe).toHaveBeenCalledTimes(3)
    expect(onRetire).not.toHaveBeenCalled()

    await clock.advance(119_999)
    expect(probe).toHaveBeenCalledTimes(3)
    await clock.advance(1)
    expect(probe).toHaveBeenCalledTimes(4)
    expect(onRetire).not.toHaveBeenCalled()
  })

  it('does not count suspension during an in-flight probe as rejection evidence', async () => {
    let resolveProbe!: (outcome: LoginPreflightOutcome) => void
    const deferredProbe = new Promise<LoginPreflightOutcome>((resolve) => {
      resolveProbe = resolve
    })
    const probe = vi
      .fn<MacosLoginSessionDeathWatchOptions['probeLoginSession']>()
      .mockResolvedValueOnce(ACCEPTED)
      .mockResolvedValueOnce(REJECTED)
      .mockReturnValueOnce(deferredProbe)
      .mockResolvedValueOnce(ACCEPTED)
    const { watch, clock, onRetire } = createWatch({ probeLoginSession: probe })
    watch.start()
    await drainMicrotasks()

    await clock.advance(120_000)
    await clock.advance(10_000)
    clock.suspend(60 * 60 * 1000)
    resolveProbe(REJECTED)
    await drainMicrotasks()

    expect(probe).toHaveBeenCalledTimes(3)
    expect(onRetire).not.toHaveBeenCalled()

    await clock.advance(119_999)
    expect(probe).toHaveBeenCalledTimes(3)
    await clock.advance(1)
    expect(probe).toHaveBeenCalledTimes(4)
    expect(onRetire).not.toHaveBeenCalled()
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

  it('retires a logged-out session three rejections and two minutes after the first one', async () => {
    const { watch, clock, onRetire } = createWatch({
      outcomes: [ACCEPTED, REJECTED, REJECTED, REJECTED, REJECTED]
    })
    watch.start()
    await drainMicrotasks()
    await clock.advance(239_999)
    expect(onRetire).not.toHaveBeenCalled()
    await clock.advance(1)
    expect(onRetire).toHaveBeenCalledTimes(1)
  })

  it.each(['healthy', 'unknown'] as const)(
    'runs no login probe while resolver health is %s, then retires once it degrades',
    async (initialResolverHealth) => {
      const { watch, clock, onRetire, probe, setResolverHealth } = createWatch({
        outcomes: [ACCEPTED, REJECTED, REJECTED, REJECTED, REJECTED]
      })
      setResolverHealth(initialResolverHealth)
      watch.start()
      await drainMicrotasks()
      for (let i = 0; i < 5; i++) {
        await clock.advance(120_000)
      }
      watch.notifyClientActivity()
      watch.notifyPtyExit()
      await clock.advance(10_000)
      expect(probe).toHaveBeenCalledTimes(1)

      setResolverHealth('unhealthy')
      await clock.advance(115_000) // Next periodic check sees the dead resolver.
      expect(probe).toHaveBeenCalledTimes(2)
      await clock.advance(119_999)
      expect(onRetire).not.toHaveBeenCalled()
      await clock.advance(1)
      expect(onRetire).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps running the login probe after a rejection until PAM accepts again, even across sleep', async () => {
    const { watch, clock, probe, setResolverHealth } = createWatch({
      outcomes: [ACCEPTED, REJECTED, ACCEPTED]
    })
    watch.start()
    await drainMicrotasks()
    await clock.advance(120_000)
    expect(probe).toHaveBeenCalledTimes(2)

    setResolverHealth('healthy')
    clock.suspend(60 * 60 * 1000)
    await clock.advance(0) // The sleep gap resets the rejection streak, not the rejected verdict.
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('stop() prevents an in-flight resolver check from retiring the daemon', async () => {
    let resolveHealth!: (health: SystemResolverHealth) => void
    let resolverSignal: AbortSignal | undefined
    const resolverHealth = new Promise<SystemResolverHealth>((resolve) => {
      resolveHealth = resolve
    })
    const { watch, clock, onRetire } = createWatch({
      outcomes: [ACCEPTED, REJECTED, REJECTED, REJECTED, REJECTED],
      // The first read is the pre-probe gate; hold only the retirement read.
      readResolverHealth: vi
        .fn<MacosLoginSessionDeathWatchOptions['readResolverHealth']>()
        .mockResolvedValueOnce('unhealthy')
        .mockImplementationOnce((signal) => {
          resolverSignal = signal
          return resolverHealth
        })
    })
    watch.start()
    await drainMicrotasks()
    await clock.advance(120_000)
    await clock.advance(10_000)
    await clock.advance(10_000)
    await clock.advance(100_000) // Retirement is waiting on the resolver result.

    watch.stop()
    expect(resolverSignal?.aborted).toBe(true)
    resolveHealth('unhealthy')
    await drainMicrotasks()

    expect(onRetire).not.toHaveBeenCalled()
  })
})
