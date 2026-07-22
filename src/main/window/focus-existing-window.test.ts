import type { App, BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { focusExistingMainWindow } from './focus-existing-window'

type FakeWindowOptions = {
  destroyed?: boolean
  minimized?: boolean
  visible?: boolean
  alwaysOnTop?: boolean
}

function makeFakeWindow(options: FakeWindowOptions = {}): BrowserWindow & {
  calls: {
    restore: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    moveTop: ReturnType<typeof vi.fn>
    setAlwaysOnTop: ReturnType<typeof vi.fn>
  }
} {
  let alwaysOnTop = options.alwaysOnTop ?? false
  const calls = {
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn(),
    setAlwaysOnTop: vi.fn((value: boolean) => {
      alwaysOnTop = value
    })
  }
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isMinimized: vi.fn(() => options.minimized ?? false),
    isVisible: vi.fn(() => options.visible ?? true),
    isAlwaysOnTop: vi.fn(() => alwaysOnTop),
    restore: calls.restore,
    show: calls.show,
    focus: calls.focus,
    moveTop: calls.moveTop,
    setAlwaysOnTop: calls.setAlwaysOnTop,
    calls
  } as unknown as BrowserWindow & { calls: typeof calls }
}

function makeFakeApp(isReady = true): Pick<App, 'focus' | 'isReady'> & {
  focus: ReturnType<typeof vi.fn>
} {
  return {
    focus: vi.fn(),
    isReady: vi.fn(() => isReady)
  } as unknown as Pick<App, 'focus' | 'isReady'> & { focus: ReturnType<typeof vi.fn> }
}

function makeTimer(): {
  setTimeout: (callback: () => void, ms: number) => number
  run: (ms: number) => void
  scheduledMs: () => number[]
} {
  const callbacks: { callback: () => void; ms: number }[] = []
  return {
    setTimeout: (callback, ms) => {
      callbacks.push({ callback, ms })
      return callbacks.length
    },
    run: (ms) => {
      // Why: splice out matching entries before invoking — real timers fire
      // once, and a retry callback here can schedule a fresh same-ms entry
      // that a later run() call must not confuse with one already fired.
      const due = callbacks.filter((entry) => entry.ms === ms)
      for (const entry of due) {
        callbacks.splice(callbacks.indexOf(entry), 1)
      }
      for (const entry of due) {
        entry.callback()
      }
    },
    scheduledMs: () => callbacks.map((entry) => entry.ms)
  }
}

describe('focusExistingMainWindow', () => {
  it('aggressively foregrounds an existing Windows window on second launch', () => {
    const app = makeFakeApp()
    const window = makeFakeWindow()
    const timer = makeTimer()

    const result = focusExistingMainWindow({
      app,
      getWindow: () => window,
      openWindow: vi.fn(),
      platform: 'win32',
      setTimeout: timer.setTimeout
    })

    expect(result).toBe('focused')
    expect(app.focus).toHaveBeenCalledWith({ steal: true })
    expect(window.calls.show).toHaveBeenCalledTimes(1)
    expect(window.calls.focus).toHaveBeenCalledTimes(1)
    expect(window.calls.moveTop).toHaveBeenCalledTimes(1)
    expect(window.calls.setAlwaysOnTop).toHaveBeenCalledWith(true)
    expect(timer.scheduledMs()).toEqual([250, 100])

    timer.run(100)
    expect(app.focus).toHaveBeenCalledTimes(2)
    expect(window.calls.focus).toHaveBeenCalledTimes(2)

    timer.run(250)
    expect(window.calls.setAlwaysOnTop).toHaveBeenLastCalledWith(false)
  })

  it('restores minimized windows before focusing them', () => {
    const window = makeFakeWindow({ minimized: true })

    focusExistingMainWindow({
      app: makeFakeApp(),
      getWindow: () => window,
      openWindow: vi.fn(),
      platform: 'darwin',
      setTimeout: makeTimer().setTimeout
    })

    expect(window.calls.restore).toHaveBeenCalledTimes(1)
    expect(window.calls.show).toHaveBeenCalledTimes(1)
    expect(window.calls.focus).toHaveBeenCalledTimes(1)
    expect(window.calls.moveTop).not.toHaveBeenCalled()
  })

  it('waits for normal startup when no window exists before app readiness', () => {
    const openWindow = vi.fn()

    const result = focusExistingMainWindow({
      app: makeFakeApp(false),
      getWindow: () => null,
      openWindow
    })

    expect(result).toBe('pending')
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('reopens the main window when the singleton reference is missing after readiness', () => {
    const app = makeFakeApp()
    const timer = makeTimer()
    const openedWindow = makeFakeWindow()
    let currentWindow: BrowserWindow | null = null
    const openWindow = vi.fn(() => {
      currentWindow = openedWindow
      return openedWindow
    })

    const result = focusExistingMainWindow({
      app,
      getWindow: () => currentWindow,
      openWindow,
      platform: 'linux',
      setTimeout: timer.setTimeout
    })

    expect(result).toBe('opened')
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openedWindow.calls.show).toHaveBeenCalledTimes(1)
    expect(openedWindow.calls.focus).toHaveBeenCalledTimes(1)
  })

  it('retries a transient reopen failure instead of stranding the app windowless', () => {
    const app = makeFakeApp()
    const timer = makeTimer()
    const openedWindow = makeFakeWindow()
    const warn = vi.fn()
    let attempts = 0
    const openWindow = vi.fn(() => {
      attempts += 1
      if (attempts < 2) {
        throw new Error('transient failure')
      }
      return openedWindow
    })

    const result = focusExistingMainWindow({
      app,
      getWindow: () => null,
      openWindow,
      warn,
      setTimeout: timer.setTimeout
    })

    // Why: the first attempt's own return value is synchronous, so a retry
    // scheduled after the first throw still reports 'pending' immediately.
    expect(result).toBe('pending')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledTimes(1)

    timer.run(300)
    expect(openWindow).toHaveBeenCalledTimes(2)
    expect(openedWindow.calls.show).toHaveBeenCalledTimes(1)
    expect(openedWindow.calls.focus).toHaveBeenCalledTimes(1)
  })

  it('adopts a window that appeared during the retry gap instead of opening a duplicate', () => {
    // Why: openMainWindow is not idempotent — a duplicate open would orphan the
    // window already on screen. If getWindow() resolves before the retry fires,
    // the retry must reveal that window and never call openWindow again.
    const app = makeFakeApp()
    const timer = makeTimer()
    const raceWindow = makeFakeWindow()
    const warn = vi.fn()
    let liveWindow: BrowserWindow | null = null
    const openWindow = vi.fn(() => {
      // First attempt throws, but a concurrent path lands a window before retry.
      liveWindow = raceWindow
      throw new Error('transient failure')
    })

    const result = focusExistingMainWindow({
      app,
      getWindow: () => liveWindow,
      openWindow,
      warn,
      setTimeout: timer.setTimeout
    })

    expect(result).toBe('pending')
    expect(openWindow).toHaveBeenCalledTimes(1)

    timer.run(300)
    // Retry adopts the raced-in window; it must not construct a second one.
    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(raceWindow.calls.show).toHaveBeenCalledTimes(1)
    expect(raceWindow.calls.focus).toHaveBeenCalledTimes(1)
  })

  it('reinforces win32 activation when a window is recovered on the retry path', () => {
    const app = makeFakeApp()
    const timer = makeTimer()
    const openedWindow = makeFakeWindow()
    const warn = vi.fn()
    let attempts = 0
    const openWindow = vi.fn(() => {
      attempts += 1
      if (attempts < 2) {
        throw new Error('transient failure')
      }
      return openedWindow
    })

    focusExistingMainWindow({
      app,
      getWindow: () => null,
      openWindow,
      warn,
      platform: 'win32',
      setTimeout: timer.setTimeout
    })

    timer.run(300)
    // Why: the retry callback must run the same win32 reinforcement + focus retry
    // as the sync success path, not just show/focus.
    expect(openedWindow.calls.moveTop).toHaveBeenCalledTimes(1)
    expect(openedWindow.calls.setAlwaysOnTop).toHaveBeenCalledWith(true)

    timer.run(100)
    expect(app.focus).toHaveBeenCalledTimes(2)
    expect(openedWindow.calls.focus).toHaveBeenCalledTimes(2)

    timer.run(250)
    expect(openedWindow.calls.setAlwaysOnTop).toHaveBeenLastCalledWith(false)
  })

  it('gives up after exhausting reopen retries', () => {
    const timer = makeTimer()
    const warn = vi.fn()
    const openWindow = vi.fn(() => {
      throw new Error('persistent failure')
    })

    const result = focusExistingMainWindow({
      app: makeFakeApp(),
      getWindow: () => null,
      openWindow,
      warn,
      setTimeout: timer.setTimeout
    })

    expect(result).toBe('pending')
    expect(openWindow).toHaveBeenCalledTimes(1)

    timer.run(300)
    timer.run(300)
    // Why: REOPEN_MAX_ATTEMPTS caps total tries at 3 (1 initial + 2 retries);
    // a further run() call must not schedule or fire a 4th attempt.
    expect(openWindow).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(3)
    timer.run(300)
    expect(openWindow).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
