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
      for (const entry of callbacks.filter((entry) => entry.ms === ms)) {
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
})
