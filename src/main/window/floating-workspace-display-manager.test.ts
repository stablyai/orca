import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import {
  closeIdentifyWindows,
  focusFloatingWorkspacePopout,
  getConnectedDisplays,
  getCurrentDisplayId,
  getFloatingWorkspacePopoutWindow,
  identifyDisplays,
  isFloatingWorkspacePopoutMinimized,
  minimizeFloatingWorkspacePopout,
  moveWindowToDisplay,
  moveWindowToNextDisplay,
  restoreFloatingWorkspacePopout,
  setFloatingWorkspacePopoutWindow
} from './floating-workspace-display-manager'

const mockScreen = vi.hoisted(() => ({
  getPrimaryDisplay: vi.fn(),
  getAllDisplays: vi.fn(),
  getDisplayMatching: vi.fn()
}))

vi.mock('electron', () => ({
  screen: mockScreen,
  BrowserWindow: vi.fn()
}))

describe('floating-workspace-display-manager', () => {
  const display1 = {
    id: 1,
    label: 'Primary Display',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1
  }

  const display2 = {
    id: 2,
    label: 'Secondary Display',
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 40, width: 2560, height: 1400 },
    scaleFactor: 1
  }

  beforeEach(() => {
    mockScreen.getPrimaryDisplay.mockReturnValue(display1)
    mockScreen.getAllDisplays.mockReturnValue([display1, display2])
    mockScreen.getDisplayMatching.mockReturnValue(display1)
    setFloatingWorkspacePopoutWindow(null)
  })

  it('tracks popout window reference and drops destroyed windows', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) }
    }
    setFloatingWorkspacePopoutWindow(mockWindow as never)
    expect(getFloatingWorkspacePopoutWindow()).toBe(mockWindow)

    mockWindow.isDestroyed.mockReturnValue(true)
    expect(getFloatingWorkspacePopoutWindow()).toBeNull()
  })

  it('returns connected displays with primary flag', () => {
    const displays = getConnectedDisplays()
    expect(displays).toHaveLength(2)
    expect(displays[0].isPrimary).toBe(true)
    expect(displays[1].isPrimary).toBe(false)
  })

  it('leaves the primary marker out of the fallback label so the menu can badge it', () => {
    mockScreen.getAllDisplays.mockReturnValue([
      { ...display1, label: '' },
      { ...display2, label: '' }
    ])

    const displays = getConnectedDisplays()
    expect(displays[0].label).toBe('Monitor 1')
    expect(displays[1].label).toBe('Monitor 2')
  })

  it('moves window to target display', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      getBounds: vi.fn(() => ({ x: 100, y: 100, width: 900, height: 600 })),
      setBounds: vi.fn()
    }

    const moved = moveWindowToDisplay(mockWindow as never, 2)
    expect(moved).toBe(true)
    expect(mockWindow.setBounds).toHaveBeenCalledWith({
      width: 900,
      height: 600,
      x: 1920 + Math.round((2560 - 900) / 2),
      y: 40 + Math.round((1400 - 600) / 2)
    })
  })

  it('moves window to next display', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      getBounds: vi.fn(() => ({ x: 100, y: 100, width: 900, height: 600 })),
      setBounds: vi.fn()
    }
    mockScreen.getDisplayMatching.mockReturnValue(display1)

    const moved = moveWindowToNextDisplay(mockWindow as never)
    expect(moved).toBe(true)
    expect(mockWindow.setBounds).toHaveBeenCalledWith({
      width: 900,
      height: 600,
      x: 1920 + Math.round((2560 - 900) / 2),
      y: 40 + Math.round((1400 - 600) / 2)
    })
  })

  it('minimizes, restores, checks minimized state, and focuses popout window', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      minimize: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      isMinimized: vi.fn(() => true)
    }

    setFloatingWorkspacePopoutWindow(mockWindow as never)

    expect(minimizeFloatingWorkspacePopout()).toBe(true)
    expect(mockWindow.minimize).toHaveBeenCalled()

    expect(isFloatingWorkspacePopoutMinimized()).toBe(true)

    expect(restoreFloatingWorkspacePopout()).toBe(true)
    expect(mockWindow.restore).toHaveBeenCalled()
    expect(mockWindow.focus).toHaveBeenCalled()

    mockWindow.isMinimized.mockReturnValue(false)
    expect(focusFloatingWorkspacePopout()).toBe(true)
    expect(mockWindow.focus).toHaveBeenCalledTimes(2)
  })

  it('reveals the popout window without stealing focus when it is ready', () => {
    const readyToShow: (() => void)[] = []
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'ready-to-show') {
          readyToShow.push(cb)
        }
      }),
      show: vi.fn(),
      showInactive: vi.fn()
    }

    setFloatingWorkspacePopoutWindow(mockWindow as never)
    expect(readyToShow).toHaveLength(1)

    readyToShow[0]()
    expect(mockWindow.show).toHaveBeenCalled()
    expect(mockWindow.showInactive).not.toHaveBeenCalled()
  })

  it('keeps the popout hidden on a windowless background launch', () => {
    const original = process.env.ORCA_BACKGROUND_LAUNCH
    const readyToShow: (() => void)[] = []
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'ready-to-show') {
          readyToShow.push(cb)
        }
      }),
      show: vi.fn(),
      showInactive: vi.fn()
    }

    try {
      process.env.ORCA_BACKGROUND_LAUNCH = '1'
      setFloatingWorkspacePopoutWindow(mockWindow as never)
      readyToShow[0]()
      expect(mockWindow.show).not.toHaveBeenCalled()
      expect(mockWindow.showInactive).not.toHaveBeenCalled()
    } finally {
      process.env.ORCA_BACKGROUND_LAUNCH = original
    }
  })

  it('does not steal OS focus in a background launch', () => {
    const original = process.env.ORCA_BACKGROUND_LAUNCH
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      isMinimized: vi.fn(() => true),
      isMaximized: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 1920, y: 0, width: 1920, height: 1080 })),
      setBounds: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn()
    }

    try {
      process.env.ORCA_BACKGROUND_LAUNCH = '1'
      setFloatingWorkspacePopoutWindow(mockWindow as never)
      expect(restoreFloatingWorkspacePopout()).toBe(true)
      mockWindow.isMinimized.mockReturnValue(false)
      expect(focusFloatingWorkspacePopout()).toBe(true)
      expect(mockWindow.focus).not.toHaveBeenCalled()
    } finally {
      process.env.ORCA_BACKGROUND_LAUNCH = original
    }
  })

  it('restores window bounds to last known bounds on restore', () => {
    const listeners: Record<string, () => void> = {}
    const bounds = { x: 1920, y: 100, width: 800, height: 600 }
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      isMinimized: vi.fn(() => true),
      isMaximized: vi.fn(() => false),
      getBounds: vi.fn(() => bounds),
      setBounds: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb
      })
    }

    setFloatingWorkspacePopoutWindow(mockWindow as never)

    // Simulate move while window is normal (not minimized)
    mockWindow.isMinimized.mockReturnValue(false)
    mockWindow.getBounds.mockReturnValue({ x: 2000, y: 150, width: 900, height: 700 })
    listeners['moved']?.()

    // Now window gets minimized
    mockWindow.isMinimized.mockReturnValue(true)

    // Calling restore should apply the updated bounds
    restoreFloatingWorkspacePopout()
    expect(mockWindow.setBounds).toHaveBeenCalledWith({ x: 2000, y: 150, width: 900, height: 700 })

    // OS-level restore event should also apply bounds
    mockWindow.setBounds.mockClear()
    listeners['restore']?.()
    expect(mockWindow.setBounds).toHaveBeenCalledWith({ x: 2000, y: 150, width: 900, height: 700 })
  })

  it('restores maximized window back to secondary monitor when restored', () => {
    const listeners: Record<string, () => void> = {}
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 1920, y: 0, width: 2560, height: 1440 })),
      setBounds: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => {
        listeners[event] = cb
      })
    }

    mockScreen.getDisplayMatching.mockReturnValue(display2)
    setFloatingWorkspacePopoutWindow(mockWindow as never)

    // Window gets maximized on display 2
    mockWindow.isMaximized.mockReturnValue(true)
    listeners['resize']?.()

    // Window gets minimized
    mockWindow.isMinimized.mockReturnValue(true)
    mockWindow.isMaximized.mockReturnValue(false)
    listeners['minimize']?.()

    // OS restores window, but initially puts it on display 1 (wrong display)
    mockWindow.isMinimized.mockReturnValue(false)
    mockWindow.isMaximized.mockReturnValue(true)
    mockWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 })
    mockScreen.getDisplayMatching.mockReturnValue(display1)

    listeners['restore']?.()

    expect(mockWindow.unmaximize).toHaveBeenCalled()
    expect(mockWindow.setBounds).toHaveBeenCalledWith({
      x: 1920 + Math.round((2560 - 960) / 2),
      y: 40 + Math.round((1400 - 640) / 2),
      width: 960,
      height: 640
    })
    expect(mockWindow.maximize).toHaveBeenCalled()
  })

  it('gets current display ID for active popout window', () => {
    expect(getCurrentDisplayId()).toBeNull()

    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 1920, y: 0, width: 1920, height: 1080 })),
      on: vi.fn()
    }

    mockScreen.getDisplayMatching.mockReturnValue(display2)
    setFloatingWorkspacePopoutWindow(mockWindow as never)

    expect(getCurrentDisplayId()).toBe(2)
  })

  it('skips display identification window creation when ORCA_BACKGROUND_LAUNCH=1', () => {
    const original = process.env.ORCA_BACKGROUND_LAUNCH
    try {
      process.env.ORCA_BACKGROUND_LAUNCH = '1'
      expect(identifyDisplays()).toBe(true)
    } finally {
      process.env.ORCA_BACKGROUND_LAUNCH = original
    }
  })

  it('cleans up identify windows when closed', () => {
    expect(() => closeIdentifyWindows()).not.toThrow()
  })

  it('closes overlays already created when a later overlay fails to build', () => {
    const closeOverlay = vi.fn()
    const overlay = {
      setIgnoreMouseEvents: vi.fn(),
      loadURL: vi.fn(),
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      close: closeOverlay
    }
    const browserWindowMock = vi.mocked(BrowserWindow)
    browserWindowMock
      .mockImplementationOnce(function overlayWindow() {
        return overlay
      } as never)
      .mockImplementationOnce(function throwingWindow() {
        throw new Error('overlay creation failed')
      } as never)

    const original = process.env.ORCA_BACKGROUND_LAUNCH
    try {
      delete process.env.ORCA_BACKGROUND_LAUNCH
      expect(identifyDisplays()).toBe(false)
    } finally {
      process.env.ORCA_BACKGROUND_LAUNCH = original
    }
    expect(closeOverlay).toHaveBeenCalled()
  })

  it('rejects non-integer display ids without touching bounds', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      getBounds: vi.fn(() => ({ x: 100, y: 100, width: 900, height: 600 })),
      setBounds: vi.fn()
    }

    for (const displayId of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(moveWindowToDisplay(mockWindow as never, displayId)).toBe(false)
    }
    expect(mockWindow.setBounds).not.toHaveBeenCalled()
  })

  it('returns false from moveWindowToNextDisplay when display lookup throws', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      getBounds: vi.fn(() => ({ x: 100, y: 100, width: 900, height: 600 })),
      setBounds: vi.fn()
    }
    mockScreen.getDisplayMatching.mockImplementation(() => {
      throw new Error('no display')
    })

    expect(moveWindowToNextDisplay(mockWindow as never)).toBe(false)
    expect(mockWindow.setBounds).not.toHaveBeenCalled()
  })

  it('returns false without focusing or placing when no displays are connected', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      isMinimized: vi.fn(() => true),
      isMaximized: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 100, y: 100, width: 900, height: 600 })),
      setBounds: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      on: vi.fn()
    }
    mockScreen.getAllDisplays.mockReturnValue([])
    setFloatingWorkspacePopoutWindow(mockWindow as never)

    expect(restoreFloatingWorkspacePopout()).toBe(false)
    expect(mockWindow.setBounds).not.toHaveBeenCalled()
    expect(mockWindow.focus).not.toHaveBeenCalled()
  })

  it('falls back to the non-primary display when the last known display is gone', () => {
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false) },
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 2000, y: 150, width: 900, height: 700 })),
      setBounds: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      on: vi.fn()
    }
    const display3 = {
      id: 3,
      label: 'Tertiary Display',
      bounds: { x: 4480, y: 0, width: 1920, height: 1080 },
      workArea: { x: 4480, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1
    }
    mockScreen.getDisplayMatching.mockReturnValue(display2)
    setFloatingWorkspacePopoutWindow(mockWindow as never)

    mockScreen.getAllDisplays.mockReturnValue([display1, display3])
    mockScreen.getDisplayMatching.mockReturnValue(display1)
    expect(restoreFloatingWorkspacePopout()).toBe(true)
    expect(mockWindow.setBounds).toHaveBeenCalledWith({
      x: 4480 + Math.round((1920 - 900) / 2),
      y: Math.round((1040 - 700) / 2),
      width: 900,
      height: 700
    })
  })
})
