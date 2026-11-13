import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdatePreferences } from '../storage/app-update-preferences'
import { createAppUpdateChecker, type AppUpdateCheckerDeps } from './app-update-checker'
import type { AppUpdateCheckResult, AppUpdateSource } from './app-update-source'

const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 28, 12)

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

  it('offers no stored update when the build has no update source', async () => {
    const { deps } = harness({
      stored: {
        lastCheckedAt: T0,
        latest: { version: '0.0.49', url: 'https://github.com/stablyai/orca/releases/tag/x' }
      }
    })
    const checker = createAppUpdateChecker({ ...deps, source: null })
    checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(checker.getSnapshot().available).toBeNull()
  })

  it('bounds a check at 8 s and counts it as failed', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 }, replies: ['hang'] })
    h.checker.start()
    const outcome = h.checker.checkNow()
    await vi.advanceTimersByTimeAsync(8000)
    await expect(outcome).resolves.toBe('failed')
    expect(h.checker.getSnapshot().checking).toBe(false)
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

  it('runs the check when the armed timer fires even if the clock stepped back', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 - 2 * HOUR } })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() - 10 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(22 * HOUR)
    expect(checks(h)).toBe(1)
  })

  it('treats a stored check time ahead of the clock as never checked', async () => {
    const h = harness({ stored: { lastCheckedAt: T0 + 365 * 24 * HOUR } })
    h.checker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(checks(h)).toBe(1)
  })
})
