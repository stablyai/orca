import { describe, expect, it, vi } from 'vitest'
import { createNoopDaemonFileLog } from './daemon-file-log'
import {
  MacosLoginWrapperDeathWatch,
  type MacosLoginWrapperDeathWatchOptions
} from './macos-login-wrapper-death-watch'
import type { PosixPtySessionLiveness } from '../pty/posix-pty-session-liveness'

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
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

function createWatch(
  overrides: Partial<MacosLoginWrapperDeathWatchOptions> & {
    outcomes?: PosixPtySessionLiveness[]
  } = {}
): {
  watch: MacosLoginWrapperDeathWatch
  clock: FakeClock
  forceKillRoot: ReturnType<typeof vi.fn>
  readLiveness: ReturnType<typeof vi.fn>
  log: ReturnType<typeof createNoopDaemonFileLog> & { log: ReturnType<typeof vi.fn> }
} {
  const clock = new FakeClock()
  const forceKillRoot = vi.fn()
  const outcomes = overrides.outcomes ?? []
  const readLiveness = vi.fn(((_rootPid: number) =>
    outcomes.length ? outcomes.shift()! : 'live'
  ) as (rootPid: number) => PosixPtySessionLiveness)
  const log = { ...createNoopDaemonFileLog(), log: vi.fn() }
  const watch = new MacosLoginWrapperDeathWatch({
    rootPid: overrides.rootPid ?? 4233,
    forceKillRoot: overrides.forceKillRoot ?? forceKillRoot,
    readLiveness: overrides.readLiveness ?? readLiveness,
    log: overrides.log ?? log,
    clock,
    timing: {
      startupGraceMs: 15_000,
      pollMs: 30_000,
      emptyRecheckMs: 5_000,
      ...overrides.timing
    }
  })
  return { watch, clock, forceKillRoot, readLiveness, log }
}

describe('MacosLoginWrapperDeathWatch', () => {
  it('does not probe during the startup grace window', async () => {
    const { watch, clock, forceKillRoot, readLiveness } = createWatch({
      outcomes: ['empty', 'empty']
    })
    watch.start()
    await clock.advance(14_999)
    expect(readLiveness).not.toHaveBeenCalled()
    expect(forceKillRoot).not.toHaveBeenCalled()
  })

  it('reaps only after two consecutive empty observations past grace', async () => {
    const { watch, clock, forceKillRoot, log } = createWatch({
      outcomes: ['empty', 'empty']
    })
    watch.start()
    await clock.advance(15_000)
    expect(forceKillRoot).not.toHaveBeenCalled()
    expect(log.log).toHaveBeenCalledWith(
      'macos-login-wrapper-empty-observed',
      expect.objectContaining({ rootPid: 4233, observations: 1 })
    )
    await clock.advance(5_000)
    expect(forceKillRoot).toHaveBeenCalledOnce()
    expect(log.log).toHaveBeenCalledWith(
      'macos-login-wrapper-empty-reaped',
      expect.objectContaining({ rootPid: 4233, observations: 2 })
    )
  })

  it('resets the empty streak when the session becomes live again', async () => {
    const { watch, clock, forceKillRoot } = createWatch({
      outcomes: ['empty', 'live', 'empty', 'empty']
    })
    watch.start()
    await clock.advance(15_000) // empty #1
    await clock.advance(5_000) // live → reset
    expect(forceKillRoot).not.toHaveBeenCalled()
    await clock.advance(30_000) // empty #1 again
    expect(forceKillRoot).not.toHaveBeenCalled()
    await clock.advance(5_000) // empty #2 → reap
    expect(forceKillRoot).toHaveBeenCalledOnce()
  })

  it('never reaps on unknown liveness', async () => {
    const { watch, clock, forceKillRoot } = createWatch({
      outcomes: ['unknown', 'unknown', 'unknown']
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(30_000)
    await clock.advance(30_000)
    expect(forceKillRoot).not.toHaveBeenCalled()
  })

  it('stops quietly when the root is already gone', async () => {
    const { watch, clock, forceKillRoot, readLiveness } = createWatch({
      outcomes: ['gone']
    })
    watch.start()
    await clock.advance(15_000)
    expect(forceKillRoot).not.toHaveBeenCalled()
    await clock.advance(60_000)
    expect(readLiveness).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels pending timers before a reap can fire', async () => {
    const { watch, clock, forceKillRoot } = createWatch({
      outcomes: ['empty', 'empty']
    })
    watch.start()
    await clock.advance(15_000)
    watch.stop()
    await clock.advance(5_000)
    expect(forceKillRoot).not.toHaveBeenCalled()
    expect(clock.pendingCount()).toBe(0)
  })

  it('does not call forceKill again after a successful reap', async () => {
    const { watch, clock, forceKillRoot, readLiveness } = createWatch({
      outcomes: ['empty', 'empty', 'empty']
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(forceKillRoot).toHaveBeenCalledOnce()
    const probesAtReap = readLiveness.mock.calls.length
    await clock.advance(60_000)
    expect(forceKillRoot).toHaveBeenCalledOnce()
    expect(readLiveness).toHaveBeenCalledTimes(probesAtReap)
  })

  it('retries after a rejected forceKill on a later empty window', async () => {
    const forceKillRoot = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('SIGKILL rejected')
      })
      .mockImplementationOnce(() => {})
    const { watch, clock, log } = createWatch({
      outcomes: ['empty', 'empty', 'empty', 'empty'],
      forceKillRoot
    })
    watch.start()
    await clock.advance(15_000)
    await clock.advance(5_000)
    expect(forceKillRoot).toHaveBeenCalledOnce()
    expect(log.log).toHaveBeenCalledWith(
      'macos-login-wrapper-empty-reap-failed',
      expect.objectContaining({ rootPid: 4233 })
    )
    await clock.advance(30_000)
    await clock.advance(5_000)
    expect(forceKillRoot).toHaveBeenCalledTimes(2)
  })
})
