import { describe, expect, it, vi } from 'vitest'
import { createNoopDaemonFileLog } from './daemon-file-log'
import {
  MacosLoginWrapperDeathWatch,
  type MacosLoginWrapperDeathWatchOptions
} from './macos-login-wrapper-death-watch'
import type { PosixPtyRootSnapshot } from '../pty/posix-pty-session-liveness'

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
      await drainMicrotasks()
    }
    this.nowMs = target
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cleared).length
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

function emptyOwned(rootPid = 4233, ownerPid = 1001): PosixPtyRootSnapshot {
  return {
    liveness: 'empty',
    rootPid,
    ppid: ownerPid,
    tty: 'ttys001',
    command: '/usr/bin/login -flpq user /bin/bash --noprofile --norc -p -c trampoline'
  }
}

function livePeer(rootPid = 4233, ownerPid = 1001): PosixPtyRootSnapshot {
  return {
    liveness: 'live',
    rootPid,
    ppid: ownerPid,
    tty: 'ttys001',
    command: '/usr/bin/login -flpq user /bin/bash'
  }
}

function createWatch(
  overrides: Partial<MacosLoginWrapperDeathWatchOptions> & {
    outcomes?: PosixPtyRootSnapshot[]
  } = {}
): {
  watch: MacosLoginWrapperDeathWatch
  clock: FakeClock
  signalRoot: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
  log: ReturnType<typeof createNoopDaemonFileLog> & { log: ReturnType<typeof vi.fn> }
} {
  const clock = new FakeClock()
  const signalRoot = vi.fn()
  const outcomes = overrides.outcomes ?? []
  const probe = vi.fn(async (_rootPid: number) =>
    outcomes.length ? outcomes.shift()! : livePeer()
  )
  const log = { ...createNoopDaemonFileLog(), log: vi.fn() }
  const watch = new MacosLoginWrapperDeathWatch({
    rootPid: overrides.rootPid ?? 4233,
    ownerPid: overrides.ownerPid ?? 1001,
    signalRoot: overrides.signalRoot ?? signalRoot,
    probe: overrides.probe ?? probe,
    log: overrides.log ?? log,
    clock,
    timing: {
      startupGraceMs: 15_000,
      pollMs: 30_000,
      emptyRecheckMs: 5_000,
      ...overrides.timing
    }
  })
  return { watch, clock, signalRoot, probe, log }
}

describe('MacosLoginWrapperDeathWatch', () => {
  it('does not probe during the startup grace window', async () => {
    const { watch, clock, signalRoot, probe } = createWatch({
      outcomes: [emptyOwned(), emptyOwned(), emptyOwned()]
    })
    watch.start()
    await clock.advance(14_999)
    expect(probe).not.toHaveBeenCalled()
    expect(signalRoot).not.toHaveBeenCalled()
  })

  it('reaps only after two empties plus a final owned-empty proof', async () => {
    const { watch, clock, signalRoot, log, probe } = createWatch({
      // poll empty, recheck empty, final proof empty
      outcomes: [emptyOwned(), emptyOwned(), emptyOwned()]
    })
    watch.start()
    await clock.advance(15_000)
    expect(signalRoot).not.toHaveBeenCalled()
    expect(log.log).toHaveBeenCalledWith(
      'macos-login-wrapper-empty-observed',
      expect.objectContaining({ rootPid: 4233, observations: 1 })
    )
    await clock.advance(5_000)
    expect(signalRoot).toHaveBeenCalledOnce()
    expect(signalRoot).toHaveBeenCalledWith(4233)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(log.log).toHaveBeenCalledWith(
      'macos-login-wrapper-empty-reaped',
      expect.objectContaining({ rootPid: 4233, observations: 2 })
    )
    const reapedOrder = log.log.mock.calls.findIndex(([e]) => e === 'macos-login-wrapper-empty-reaped')
    // reaped is emitted only after signalRoot returned (call already recorded)
    expect(signalRoot.mock.invocationCallOrder[0]).toBeLessThan(
      log.log.mock.invocationCallOrder[reapedOrder]
    )
  })

  it('emits reaped only after a successful signal, never before', async () => {
    const callOrder: string[] = []
    const signalRoot = vi.fn(() => {
      callOrder.push('signal')
    })
    const log = {
      ...createNoopDaemonFileLog(),
      log: vi.fn((event: string) => {
        callOrder.push(event)
      })
    }
    const { watch, clock } = createWatch({
      outcomes: [emptyOwned(), emptyOwned(), emptyOwned()],
      signalRoot,
      log
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(callOrder.filter((e) => e === 'signal' || e === 'macos-login-wrapper-empty-reaped')).toEqual(
      ['signal', 'macos-login-wrapper-empty-reaped']
    )
    expect(callOrder).not.toContain('macos-login-wrapper-empty-reap-failed')
  })

  it('on signal failure emits only the failure event and keeps watching', async () => {
    const signalRoot = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('SIGKILL rejected')
      })
      .mockImplementationOnce(() => {})
    const { watch, clock, log } = createWatch({
      outcomes: [
        emptyOwned(),
        emptyOwned(),
        emptyOwned(),
        emptyOwned(),
        emptyOwned(),
        emptyOwned()
      ],
      signalRoot
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(signalRoot).toHaveBeenCalledOnce()
    expect(log.log).toHaveBeenCalledWith(
      'macos-login-wrapper-empty-reap-failed',
      expect.objectContaining({ rootPid: 4233 })
    )
    expect(log.log.mock.calls.some(([e]) => e === 'macos-login-wrapper-empty-reaped')).toBe(false)

    await clock.advance(30_000)
    await clock.advance(5_000)
    expect(signalRoot).toHaveBeenCalledTimes(2)
    expect(log.log).toHaveBeenCalledWith(
      'macos-login-wrapper-empty-reaped',
      expect.objectContaining({ rootPid: 4233 })
    )
  })

  it('resets when the session becomes live again before reap', async () => {
    const { watch, clock, signalRoot } = createWatch({
      outcomes: [emptyOwned(), livePeer(), emptyOwned(), emptyOwned(), emptyOwned()]
    })
    watch.start()
    await clock.advance(15_000) // empty #1
    await clock.advance(5_000) // live → reset
    expect(signalRoot).not.toHaveBeenCalled()
    await clock.advance(30_000) // empty #1
    await clock.advance(5_000) // empty #2 + final proof
    expect(signalRoot).toHaveBeenCalledOnce()
  })

  it('aborts reap when a peer reappears on the final ownership proof', async () => {
    const { watch, clock, signalRoot, log } = createWatch({
      outcomes: [emptyOwned(), emptyOwned(), livePeer()]
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(signalRoot).not.toHaveBeenCalled()
    expect(log.log.mock.calls.some(([e]) => e === 'macos-login-wrapper-empty-reaped')).toBe(false)
    expect(log.log.mock.calls.some(([e]) => e === 'macos-login-wrapper-empty-reap-failed')).toBe(
      false
    )
  })

  it('aborts reap on ownership mismatch / PID reuse (wrong ppid or command)', async () => {
    const reused = {
      ...emptyOwned(),
      ppid: 9999,
      command: '/bin/zsh -l'
    }
    const { watch, clock, signalRoot, log } = createWatch({
      outcomes: [emptyOwned(), emptyOwned(), reused]
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(signalRoot).not.toHaveBeenCalled()
    expect(log.log.mock.calls.some(([e]) => e === 'macos-login-wrapper-empty-reaped')).toBe(false)
  })

  it('never reaps on unknown liveness from slow/rejected probes', async () => {
    const { watch, clock, signalRoot } = createWatch({
      outcomes: [
        { liveness: 'unknown', rootPid: 4233, ppid: null, tty: null, command: null },
        { liveness: 'unknown', rootPid: 4233, ppid: null, tty: null, command: null }
      ]
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(30_000)
    expect(signalRoot).not.toHaveBeenCalled()
  })

  it('treats a throwing probe as unknown (fail closed)', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('ps timed out'))
      .mockResolvedValueOnce(livePeer())
    const { watch, clock, signalRoot } = createWatch({ probe })
    watch.start()
    await clock.advance(15_000)
    expect(signalRoot).not.toHaveBeenCalled()
    await clock.advance(30_000)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not overlap probes while one is in flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let release!: (snap: PosixPtyRootSnapshot) => void
    const first = new Promise<PosixPtyRootSnapshot>((resolve) => {
      release = resolve
    })
    const probe = vi
      .fn()
      .mockImplementationOnce(async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          return await first
        } finally {
          inFlight--
        }
      })
      .mockImplementation(async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        inFlight--
        return livePeer()
      })
    const { watch, clock } = createWatch({ probe })
    watch.start()
    await clock.advance(15_000)
    expect(probe).toHaveBeenCalledTimes(1)
    // A second timer would not be scheduled until the first probe settles.
    expect(clock.pendingCount()).toBe(0)
    release(livePeer())
    await drainMicrotasks()
    expect(maxInFlight).toBe(1)
    await clock.advance(30_000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(1)
  })

  it('stop() during an in-flight probe prevents later kill and log', async () => {
    let release!: (snap: PosixPtyRootSnapshot) => void
    const deferred = new Promise<PosixPtyRootSnapshot>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(async () => deferred)
    const { watch, clock, signalRoot, log } = createWatch({ probe })
    watch.start()
    await clock.advance(15_000)
    expect(probe).toHaveBeenCalledTimes(1)
    watch.stop()
    release(emptyOwned())
    await drainMicrotasks()
    expect(signalRoot).not.toHaveBeenCalled()
    expect(log.log).not.toHaveBeenCalled()
    expect(clock.pendingCount()).toBe(0)
  })

  it('stop() during the final proof probe prevents kill and reaped log', async () => {
    let releaseFinal!: (snap: PosixPtyRootSnapshot) => void
    const finalProbe = new Promise<PosixPtyRootSnapshot>((resolve) => {
      releaseFinal = resolve
    })
    const probe = vi
      .fn()
      .mockResolvedValueOnce(emptyOwned())
      .mockResolvedValueOnce(emptyOwned())
      .mockImplementationOnce(async () => finalProbe)
    const { watch, clock, signalRoot, log } = createWatch({ probe })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(probe).toHaveBeenCalledTimes(3)
    watch.stop()
    releaseFinal(emptyOwned())
    await drainMicrotasks()
    expect(signalRoot).not.toHaveBeenCalled()
    expect(log.log.mock.calls.some(([e]) => e === 'macos-login-wrapper-empty-reaped')).toBe(false)
  })

  it('stops quietly when the root is already gone', async () => {
    const { watch, clock, signalRoot, probe } = createWatch({
      outcomes: [
        { liveness: 'gone', rootPid: 4233, ppid: null, tty: null, command: null }
      ]
    })
    watch.start()
    await clock.advance(15_000)
    expect(signalRoot).not.toHaveBeenCalled()
    await clock.advance(60_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not signal again after a successful reap', async () => {
    const { watch, clock, signalRoot, probe } = createWatch({
      outcomes: [emptyOwned(), emptyOwned(), emptyOwned(), emptyOwned()]
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(signalRoot).toHaveBeenCalledOnce()
    const probesAtReap = probe.mock.calls.length
    await clock.advance(60_000)
    expect(signalRoot).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledTimes(probesAtReap)
  })
})
