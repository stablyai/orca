import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Rectangle } from 'electron'

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const screen = {
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    },
    on: (event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    removeAllListeners: () => listeners.clear(),
    removeListener: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
    getAllDisplays: vi.fn(),
    getDisplayMatching: vi.fn(),
    getPrimaryDisplay: vi.fn()
  } as unknown as {
    emit: (event: string) => void
    on: (event: string, listener: () => void) => void
    removeAllListeners: () => void
    removeListener: (event: string, listener: () => void) => void
    getAllDisplays: ReturnType<typeof vi.fn>
    getDisplayMatching: ReturnType<typeof vi.fn>
    getPrimaryDisplay: ReturnType<typeof vi.fn>
  }
  return { screen }
})

vi.mock('electron', () => ({ screen: electronMock.screen }))

import {
  installMainWindowReachabilityLifecycle,
  isMainWindowReachable,
  recoverMainWindowBounds
} from './main-window-reachability'

function makeWindow(bounds: Rectangle): BrowserWindow & {
  emitWindow: (event: string) => void
  setBounds: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, Set<() => void>>()
  let currentBounds = bounds
  const setBounds = vi.fn((nextBounds: Rectangle) => {
    currentBounds = nextBounds
  })
  return {
    emitWindow: (event) => {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    },
    getBounds: vi.fn(() => currentBounds),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    on: vi.fn((event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    removeListener: vi.fn((event: string, listener: () => void) =>
      listeners.get(event)?.delete(listener)
    ),
    setBounds
  } as unknown as BrowserWindow & {
    emitWindow: (event: string) => void
    setBounds: ReturnType<typeof vi.fn>
  }
}

describe('main window reachability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electronMock.screen.removeAllListeners()
    electronMock.screen.getAllDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1440, height: 900 } }
    ])
    electronMock.screen.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    })
    electronMock.screen.getDisplayMatching.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('preserves a side-parked window with a grabbable titlebar slice', () => {
    const window = makeWindow({ x: -1110, y: 0, width: 1200, height: 800 })

    expect(isMainWindowReachable(window)).toBe(true)
    expect(recoverMainWindowBounds(window)).toBe(false)
    expect(window.setBounds).not.toHaveBeenCalled()
  })

  it('preserves a top-parked window with a grabbable titlebar slice', () => {
    expect(isMainWindowReachable(makeWindow({ x: 0, y: -20, width: 1200, height: 800 }))).toBe(true)
  })

  it('rejects a barely peeking titlebar that cannot be grabbed', () => {
    expect(isMainWindowReachable(makeWindow({ x: -1180, y: 0, width: 1200, height: 800 }))).toBe(
      false
    )
  })

  it('rejects a bottom slice whose titlebar is above an attached display', () => {
    expect(isMainWindowReachable(makeWindow({ x: 0, y: -600, width: 1200, height: 800 }))).toBe(
      false
    )
  })

  it.each(['isMaximized', 'isFullScreen'] as const)(
    'leaves native %s placement to the operating system',
    (state) => {
      const window = makeWindow({ x: 5000, y: -3000, width: 1200, height: 800 })
      vi.mocked(window[state]).mockReturnValue(true)

      expect(isMainWindowReachable(window)).toBe(true)
    }
  )

  it('clamps an unreachable window into its matching display work area', () => {
    electronMock.screen.getDisplayMatching.mockReturnValue({
      workArea: { x: 1440, y: -900, width: 1920, height: 900 }
    })
    const bounds = { x: 5000, y: -3000, width: 1200, height: 800 }
    const window = makeWindow(bounds)

    expect(recoverMainWindowBounds(window)).toBe(true)
    expect(electronMock.screen.getDisplayMatching).toHaveBeenCalledWith(bounds)
    expect(window.setBounds).toHaveBeenCalledWith({ x: 2160, y: -900, width: 1200, height: 800 })
  })

  it('falls back to the primary work area when display matching fails', () => {
    electronMock.screen.getDisplayMatching.mockImplementation(() => {
      throw new Error('display topology is unsettled')
    })
    const window = makeWindow({ x: 5000, y: -3000, width: 1200, height: 800 })

    expect(recoverMainWindowBounds(window)).toBe(true)
    expect(window.setBounds).toHaveBeenCalledWith({ x: 240, y: 0, width: 1200, height: 800 })
  })

  it.each(['display-added', 'display-removed', 'display-metrics-changed'])(
    'recovers after %s and releases display listeners on close',
    (event) => {
      const window = makeWindow({ x: 5000, y: -3000, width: 1200, height: 800 })
      const dispose = installMainWindowReachabilityLifecycle(window)

      electronMock.screen.emit(event)
      expect(window.setBounds).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(window.setBounds).toHaveBeenCalledTimes(1)

      dispose()
      electronMock.screen.emit(event)
      window.emitWindow('show')
      vi.runAllTimers()
      expect(window.setBounds).toHaveBeenCalledTimes(1)
    }
  )

  it('coalesces normal-state window events on a fresh event-loop turn', () => {
    const window = makeWindow({ x: 5000, y: -3000, width: 1200, height: 800 })
    installMainWindowReachabilityLifecycle(window)

    for (const event of ['show', 'restore', 'unmaximize', 'leave-full-screen']) {
      window.emitWindow(event)
    }
    expect(window.setBounds).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(window.setBounds).toHaveBeenCalledTimes(1)

    window.emitWindow('show')
    vi.runAllTimers()
    expect(window.setBounds).toHaveBeenCalledTimes(1)
  })

  it.each(['isMaximized', 'isFullScreen'] as const)('does not alter native %s state', (state) => {
    const window = makeWindow({ x: 5000, y: -3000, width: 1200, height: 800 })
    vi.mocked(window[state]).mockReturnValue(true)

    expect(recoverMainWindowBounds(window)).toBe(false)
    expect(window.setBounds).not.toHaveBeenCalled()
  })
})
