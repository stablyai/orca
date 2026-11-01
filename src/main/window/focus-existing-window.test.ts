import type { App, BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      // Remove due callbacks before invoking; retries may schedule new same-ms timers that must remain pending.
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

// These cases exercise foreground behavior against Electron mocks.
beforeEach(() => {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  vi.stubEnv('ORCA_E2E_HEADLESS', undefined)
  vi.stubEnv('ORCA_E2E_HEADFUL', undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('focusExistingMainWindow', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'never restores or activates a background window on %s',
    (platform) => {
      vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
      vi.stubEnv('ORCA_E2E_FOREGROUND', '1')
      const app = makeFakeApp()
      const window = makeFakeWindow({ minimized: true })
      const timer = makeTimer()
      focusExistingMainWindow({
        app,
        getWindow: () => window,
        openWindow: vi.fn(),
        platform,
        setTimeout: timer.setTimeout
      })
      expect(app.focus).not.toHaveBeenCalled()
      for (const call of Object.values(window.calls)) {
        expect(call).not.toHaveBeenCalled()
      }
      expect(timer.scheduledMs()).toEqual([])
    }
  )

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
    const timer = makeTimer()

    focusExistingMainWindow({
      app: makeFakeApp(),
      getWindow: () => window,
      openWindow: vi.fn(),
      platform: 'darwin',
      setTimeout: timer.setTimeout
    })

    expect(window.calls.restore).toHaveBeenCalledTimes(1)
    expect(window.calls.show).toHaveBeenCalledTimes(1)
    expect(window.calls.focus).toHaveBeenCalledTimes(1)
    expect(window.calls.moveTop).not.toHaveBeenCalled()
    expect(timer.scheduledMs()).toEqual([])
  })

  // Install-DACL repair owns first-window startup; a second instance must not launch into the tree icacls is rewriting.
  it('drops a reopen while another path must own the first window', () => {
    const openWindow = vi.fn()

    const result = focusExistingMainWindow({
      app: makeFakeApp(),
      getWindow: () => null,
      openWindow,
      canOpenWindow: () => false
    })

    expect(result).toBe('pending')
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('still focuses a window that already exists while reopening is held', () => {
    const window = makeFakeWindow()
    const openWindow = vi.fn()

    const result = focusExistingMainWindow({
      app: makeFakeApp(),
      getWindow: () => window,
      openWindow,
      canOpenWindow: () => false,
      platform: 'darwin',
      setTimeout: makeTimer().setTimeout
    })

    expect(result).toBe('focused')
    expect(openWindow).not.toHaveBeenCalled()
    expect(window.calls.focus).toHaveBeenCalledTimes(1)
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

    // Initial return stays synchronously pending even when a retry follows the first throw.
    expect(result).toBe('pending')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledTimes(1)

    timer.run(300)
    expect(openWindow).toHaveBeenCalledTimes(2)
    expect(openedWindow.calls.show).toHaveBeenCalledTimes(1)
    expect(openedWindow.calls.focus).toHaveBeenCalledTimes(1)
  })

  it('adopts a window that appeared during the retry gap instead of opening a duplicate', () => {
    // openWindow is not idempotent; adopt a raced-in window on retry or duplicate construction orphans it.
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
    // Retries need the same Windows foreground reinforcement as synchronous success.
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
    expect(openWindow).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(3)
    timer.run(300)
    expect(openWindow).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
