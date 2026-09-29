import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdatePreferences } from '../storage/app-update-preferences'
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  createAppUpdateChecker,
  undismissedAppUpdate,
  type AppUpdateCheckerDeps
} from './app-update-checker'
import type { AppUpdateCheckResult, AppUpdateSource } from './app-update-source'

const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 28, 12)
const RELEASE_051 = { version: '0.0.51', url: 'https://example.test/0.0.51' }

type Harness = ReturnType<typeof harness>

function harness(opts: {
  stored?: Partial<AppUpdatePreferences>
  installedVersion?: string
  replies?: (AppUpdateCheckResult | Error | 'hang' | Promise<AppUpdateCheckResult>)[]
  load?: Promise<void>
}) {
  const replies = [...(opts.replies ?? [])]
  let foreground: () => void = () => {}
  const saves: unknown[] = []
  const source: AppUpdateSource = {
    check: vi.fn(async () => {
      const reply = replies.shift() ?? { kind: 'current' }
      if (reply instanceof Promise) {
        return reply
      }
      if (reply === 'hang') {
        return new Promise<never>(() => {})
      }
      if (reply instanceof Error) {
        throw reply
      }
      return reply
    })
  }
  const deps = {
    source,
    installedVersion: opts.installedVersion ?? '0.0.48',
    now: () => Date.now(),
    setTimer: (run: () => void, delayMs: number) => setTimeout(run, delayMs),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    subscribeForeground: (listener: () => void) => {
      foreground = listener
      return () => {
        foreground = () => {}
      }
    },
    loadPreferences: vi.fn(async () => {
      await opts.load
      return {
        lastCheckedAt: null,
        latest: null,
        dismissedVersion: null,
        ...opts.stored
      }
    }),
    saveCheck: async (checkedAt: number, latest: AppUpdatePreferences['latest']) => {
      saves.push({ checkedAt, latest })
    },
    saveDismissedVersion: async (version: string) => {
      saves.push({ dismissed: version })
    }
  } satisfies AppUpdateCheckerDeps
  const checker = createAppUpdateChecker(deps)
  return { checker, source, saves, deps, foreground: () => foreground() }
}

const checks = (h: Harness) => vi.mocked(h.source.check).mock.calls.length

describe('app update checker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks on cold start when it has never succeeded, and records the result', async () => {
    const h = harness({ replies: [{ kind: 'available', ...RELEASE_051 }] })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(checks(h)).toBe(1)
    expect(h.checker.getSnapshot()).toMatchObject({ lastCheckedAt: T0, available: RELEASE_051 })
    expect(h.saves).toEqual([{ checkedAt: T0, latest: RELEASE_051 }])
  })

  it('skips the cold-start check inside 24 h, then runs it when the day is up', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 - 2 * HOUR, latest: RELEASE_051 } })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(checks(h)).toBe(0)
    expect(h.checker.getSnapshot().available).toEqual(RELEASE_051)
    await vi.advanceTimersByTimeAsync(22 * HOUR - 1)
    expect(checks(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks(h)).toBe(1)
  })

  it('checks on foreground only once the last success is 24 h old', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 - 23 * HOUR } })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    h.foreground()
    await vi.advanceTimersByTimeAsync(0)
    expect(checks(h)).toBe(0)
    // Background suspends timers; the system clock still moves.
    vi.setSystemTime(T0 + HOUR)
    h.foreground()
    await vi.advanceTimersByTimeAsync(0)
    expect(checks(h)).toBe(1)
  })

  it('retries a failed check after 1 h, not sooner, and keeps the last success time', async () => {
    const h = harness({
      stored: { lastCheckedAt: T0 - 30 * HOUR },
      replies: [new Error('offline')]
    })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(checks(h)).toBe(1)
    expect(h.checker.getSnapshot().lastCheckedAt).toBe(T0 - 30 * HOUR)
    h.foreground()
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(checks(h)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks(h)).toBe(2)
    expect(h.checker.getSnapshot().lastCheckedAt).toBe(T0 + HOUR)
  })

  it('bounds a check at 8 s and counts it as failed', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 }, replies: ['hang'] })
    h.checker.start()
    const outcome = h.checker.checkNow()
    await vi.advanceTimersByTimeAsync(8000)
    await expect(outcome).resolves.toBe('failed')
    expect(h.checker.getSnapshot().checking).toBe(false)
  })

  it('joins a manual check to one already in flight', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 }, replies: [{ kind: 'current' }] })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    const [first, second] = [h.checker.checkNow(), h.checker.checkNow()]
    await expect(Promise.all([first, second])).resolves.toEqual(['up-to-date', 'up-to-date'])
    expect(checks(h)).toBe(1)
  })

  it('manual check reschedules the next automatic check a full day out', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 - 23 * HOUR } })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    await h.checker.checkNow()
    await vi.advanceTimersByTimeAsync(24 * HOUR - 1)
    expect(checks(h)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks(h)).toBe(2)
  })

  it('dismisses one version only; the next release offers again', async () => {
    const h = harness({
      stored: { lastCheckedAt: T0 - 25 * HOUR },
      replies: [
        { kind: 'available', ...RELEASE_051 },
        { kind: 'available', version: '0.0.52', url: 'https://example.test/0.0.52' }
      ]
    })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    h.checker.dismiss('0.0.51')
    await vi.advanceTimersByTimeAsync(0)
    expect(undismissedAppUpdate(h.checker.getSnapshot())).toBeNull()
    expect(h.checker.getSnapshot().available).toEqual(RELEASE_051)
    expect(h.saves).toContainEqual({ dismissed: '0.0.51' })
    await h.checker.checkNow()
    expect(undismissedAppUpdate(h.checker.getSnapshot())?.version).toBe('0.0.52')
  })

  it('keeps a stored dismissal across restarts', async () => {
    const h = harness({
      stored: { lastCheckedAt: T0, latest: RELEASE_051, dismissedVersion: '0.0.51' }
    })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(undismissedAppUpdate(h.checker.getSnapshot())).toBeNull()
  })

  it('stops offering a stored update once the binary has been updated to it', async () => {
    const h = harness({
      installedVersion: '0.0.51',
      stored: { lastCheckedAt: T0, latest: RELEASE_051 }
    })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.checker.getSnapshot().available).toBeNull()
  })

  it('stops scheduling after stop()', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 - 2 * HOUR } })
    const stop = h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(2 * APP_UPDATE_CHECK_INTERVAL_MS)
    expect(checks(h)).toBe(0)
  })

  it('keeps the 1 h retry for a manual check that fails while the store is still loading', async () => {
    let finishLoad: () => void = () => {}
    const h = harness({
      stored: { lastCheckedAt: T0 - 30 * HOUR },
      replies: [new Error('offline')],
      load: new Promise<void>((resolve) => {
        finishLoad = resolve
      })
    })
    h.checker.start()
    const outcome = h.checker.checkNow()
    finishLoad()
    await expect(outcome).resolves.toBe('failed')
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(checks(h)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks(h)).toBe(2)
  })

  it('applies one load and runs one check across a StrictMode-style double start', async () => {
    const h = harness({})
    h.checker.start()()
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deps.loadPreferences).toHaveBeenCalledTimes(1)
    expect(checks(h)).toBe(1)
  })

  function deferredReply() {
    let answer: (result: AppUpdateCheckResult) => void = () => {}
    const reply = new Promise<AppUpdateCheckResult>((resolve) => {
      answer = resolve
    })
    return { reply, answer: (result: AppUpdateCheckResult) => answer(result) }
  }

  it('arms no timer for a check that finishes after stop()', async () => {
    const pending = deferredReply()
    const h = harness({ stored: { lastCheckedAt: T0 }, replies: [pending.reply] })
    const stop = h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    const outcome = h.checker.checkNow()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    pending.answer({ kind: 'current' })
    await outcome
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules the next check when a check in flight across stop and restart completes', async () => {
    const pending = deferredReply()
    const h = harness({ stored: { lastCheckedAt: T0 }, replies: [pending.reply] })
    const stop = h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    const outcome = h.checker.checkNow()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    pending.answer({ kind: 'current' })
    await outcome
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(checks(h)).toBe(2)
  })
})
