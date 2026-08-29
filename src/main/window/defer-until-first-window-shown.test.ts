import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: unknown[]) => void

const appListeners = new Map<string, Listener[]>()

vi.mock('electron', () => ({
  app: {
    once: (event: string, listener: Listener) => {
      const existing = appListeners.get(event) ?? []
      existing.push(listener)
      appListeners.set(event, existing)
    }
  }
}))

const { deferUntilFirstWindowShown, FIRST_WINDOW_SHOWN_FALLBACK_MS } =
  await import('./defer-until-first-window-shown')

/** Stands in for the BrowserWindow the app creates first. */
function createWindow(): { reveal: () => void } {
  const revealListeners: Listener[] = []
  const window = {
    once: (event: string, listener: Listener) => {
      if (event === 'ready-to-show') {
        revealListeners.push(listener)
      }
    }
  }
  appListeners
    .get('browser-window-created')
    ?.splice(0)
    .forEach((listener) => listener({}, window))
  return { reveal: () => revealListeners.splice(0).forEach((listener) => listener()) }
}

describe('deferUntilFirstWindowShown', () => {
  let runs: number

  beforeEach(() => {
    vi.useFakeTimers()
    appListeners.clear()
    runs = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const arm = (): void => deferUntilFirstWindowShown(() => void (runs += 1))

  /** Runs an already-queued setImmediate; the 1ms is slack, not a delay under test. */
  const drain = (): void => void vi.advanceTimersByTime(1)

  it('does not run while the first window is still being created', () => {
    arm()
    createWindow()
    // Why drain: creation alone must arm nothing. Asserting before the queue drains would also
    // pass if the task were merely queued off `browser-window-created`, which still lands before
    // the window paints.
    drain()
    expect(runs).toBe(0)
  })

  it('runs once the window is ready to show', () => {
    arm()
    const window = createWindow()
    window.reveal()
    // Why: the reveal handler must return before a blocking task runs, or the paint it is
    // waiting on is the thing being blocked.
    expect(runs).toBe(0)
    drain()
    expect(runs).toBe(1)
  })

  it('still runs when ready-to-show never fires, so a failed reveal is not silent', () => {
    arm()
    createWindow()
    // Why bracket the wait instead of flushing every timer: an unbounded flush passes for any
    // fallback delay, including one long enough to never arrive in a real session.
    vi.advanceTimersByTime(FIRST_WINDOW_SHOWN_FALLBACK_MS - 1_000)
    drain()
    expect(runs).toBe(0)
    vi.advanceTimersByTime(1_100)
    drain()
    expect(runs).toBe(1)
  })

  it('runs once when the window reveals and the fallback would also have elapsed', () => {
    arm()
    const window = createWindow()
    window.reveal()
    drain()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(FIRST_WINDOW_SHOWN_FALLBACK_MS * 2)
    drain()
    expect(runs).toBe(1)
  })

  it('fires within the window-reveal fallback, so the task cannot trail an on-screen app', () => {
    // Why read the peer constant instead of restating it: the deadline that matters is the one
    // `main-window-state-lifecycle.ts` uses to reveal the window when `ready-to-show` never fires
    // (#8421). A fallback later than that leaves the app interactive with the task still pending —
    // for the keyring deferral, interactive with every protected secret still withheld.
    // Why source text and not an import: that module pulls in electron and the e2e config at
    // module scope, which this file's `electron` stub does not satisfy.
    const revealSource = readFileSync(
      join(process.cwd(), 'src/main/window/main-window-state-lifecycle.ts'),
      'utf8'
    )
    const declaration = /export const INITIAL_REVEAL_FALLBACK_MS = ([\d_]+)/.exec(revealSource)
    // Why assert the match: a rename would make the number `NaN`, and every comparison below
    // would then pass vacuously.
    expect(declaration).not.toBeNull()
    const revealFallbackMs = Number(declaration![1].replaceAll('_', ''))
    expect(revealFallbackMs).toBeGreaterThan(0)

    expect(FIRST_WINDOW_SHOWN_FALLBACK_MS).toBeGreaterThan(revealFallbackMs)
    // Why a ceiling and not just an ordering: 15s (the updater deferral's constant) sits 5s past
    // the reveal, and being merely "after" the reveal is what made that gap invisible.
    expect(FIRST_WINDOW_SHOWN_FALLBACK_MS).toBeLessThanOrEqual(revealFallbackMs + 2_000)
  })

  it('does not run again when the window reveals after the fallback already ran', () => {
    // Why this order and not the reverse: a GPU that presents late reveals the window after the
    // fallback has run, and a second blocking task would freeze the main thread exactly as the
    // user starts interacting.
    arm()
    const window = createWindow()
    vi.advanceTimersByTime(FIRST_WINDOW_SHOWN_FALLBACK_MS + 100)
    drain()
    expect(runs).toBe(1)
    window.reveal()
    drain()
    expect(runs).toBe(1)
  })
})
