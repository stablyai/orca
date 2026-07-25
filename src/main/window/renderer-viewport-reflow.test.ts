import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const scaleFactorMock = { value: 1 }
vi.mock('electron', () => ({
  screen: { getDisplayMatching: vi.fn(() => ({ scaleFactor: scaleFactorMock.value })) }
}))

import {
  reflowRendererViewport,
  VIEWPORT_REFLOW_RESTORE_ATTEMPTS,
  VIEWPORT_REFLOW_SETTLE_MS
} from './renderer-viewport-reflow'

function createWindow(overrides: Record<string, unknown> = {}): BrowserWindow {
  const webContents = {
    isDestroyed: vi.fn(() => false),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn()
  }
  return {
    webContents,
    isDestroyed: vi.fn(() => false),
    getContentSize: vi.fn(() => [1200, 800]),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 840 })),
    setSize: vi.fn(),
    setBounds: vi.fn(),
    ...overrides
  } as unknown as BrowserWindow
}

describe('reflowRendererViewport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    scaleFactorMock.value = 1
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never mutates the native window frame', () => {
    const window = createWindow()
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.setSize).not.toHaveBeenCalled()
    expect(window.setBounds).not.toHaveBeenCalled()
  })

  it('defers the emulation off the caller stack, then restores the real viewport', () => {
    const window = createWindow()
    reflowRendererViewport(window)
    // Why: nothing may run while AppKit's callout frame is still on the stack.
    expect(window.webContents.enableDeviceEmulation).not.toHaveBeenCalled()

    vi.advanceTimersByTime(0)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledWith({
      screenPosition: 'desktop',
      screenSize: { width: 1200, height: 800 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 1.25,
      viewSize: { width: 1200, height: 800 },
      scale: 1
    })
    expect(window.webContents.disableDeviceEmulation).not.toHaveBeenCalled()

    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS)
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(1)
  })

  // Why: a CSS-pixel delta re-grids terminals sitting on an xterm row boundary, so the emulated
  // viewport must match the real one exactly — the scale factor is the only thing allowed to move.
  it('emulates the real viewport size so no terminal re-grids mid-reflow', () => {
    const window = createWindow()
    reflowRendererViewport(window)
    vi.advanceTimersByTime(0)
    const [params] = (window.webContents.enableDeviceEmulation as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Electron.Parameters]
    expect(params.viewSize).toEqual({ width: 1200, height: 800 })
    expect(params.screenSize).toEqual({ width: 1200, height: 800 })
    expect(params.scale).toBe(1)
  })

  // Why: a constant scale factor would equal the real one on a 1.25x display and reflow nothing.
  it('offsets from the display the window is actually on', () => {
    scaleFactorMock.value = 1.25
    const window = createWindow()
    reflowRendererViewport(window)
    vi.advanceTimersByTime(0)
    const [params] = (window.webContents.enableDeviceEmulation as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Electron.Parameters]
    expect(params.deviceScaleFactor).toBe(1.5)
  })

  // Why: a display reporting 0 would emulate 0.25 and shrink everything.
  it('falls back to 1x when the display reports no scale factor', () => {
    scaleFactorMock.value = 0
    const window = createWindow()
    reflowRendererViewport(window)
    vi.advanceTimersByTime(0)
    const [params] = (window.webContents.enableDeviceEmulation as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Electron.Parameters]
    expect(params.deviceScaleFactor).toBe(1.25)
  })

  it('collapses a burst of reveals into one emulation cycle', () => {
    const window = createWindow()
    for (let i = 0; i < 5; i += 1) {
      reflowRendererViewport(window)
    }
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(1)
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(1)
  })

  it('re-arms once the cycle finishes', () => {
    const window = createWindow()
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(2)
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(2)
  })

  it('skips a window destroyed before the deferred turn runs', () => {
    const window = createWindow()
    reflowRendererViewport(window)
    vi.mocked(window.isDestroyed).mockReturnValue(true)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).not.toHaveBeenCalled()
  })

  it('skips a webContents destroyed before the deferred turn runs', () => {
    const window = createWindow()
    reflowRendererViewport(window)
    vi.mocked(window.webContents.isDestroyed).mockReturnValue(true)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).not.toHaveBeenCalled()
  })

  it('does not leave emulation on when the window dies mid-cycle', () => {
    const window = createWindow()
    reflowRendererViewport(window)
    vi.advanceTimersByTime(0)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(1)

    vi.mocked(window.isDestroyed).mockReturnValue(true)
    expect(() => vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS)).not.toThrow()
    expect(window.webContents.disableDeviceEmulation).not.toHaveBeenCalled()

    // Why: a stuck latch would silently disable every later reflow for this window.
    vi.mocked(window.isDestroyed).mockReturnValue(false)
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(2)
  })

  it('recovers the latch when enabling emulation throws', () => {
    const window = createWindow()
    vi.mocked(window.webContents.enableDeviceEmulation).mockImplementationOnce(() => {
      throw new Error('Object has been destroyed')
    })
    reflowRendererViewport(window)
    expect(() => vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)).not.toThrow()
    // Why: nothing was applied, so no restore should be attempted.
    expect(window.webContents.disableDeviceEmulation).not.toHaveBeenCalled()

    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(2)
  })

  it('retries the restore rather than stranding a live renderer at the overshot viewport', () => {
    const window = createWindow()
    vi.mocked(window.webContents.disableDeviceEmulation).mockImplementationOnce(() => {
      throw new Error('transient failure')
    })
    reflowRendererViewport(window)
    expect(() => vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)).not.toThrow()

    // Why: the webContents is still alive, so the emulated viewport is still applied — giving up
    // here would leave the renderer stuck at the overshot height forever.
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(2)

    // Why: the retry succeeded, so the latch is free and later reveals still reflow.
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(2)
  })

  it('holds the latch while a restore is still being retried', () => {
    const window = createWindow()
    vi.mocked(window.webContents.disableDeviceEmulation).mockImplementation(() => {
      throw new Error('still failing')
    })
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)

    // Why: stacking a second emulation over an unrestored viewport would compound the overshoot.
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(1)
  })

  it('stops retrying the restore and re-arms after the attempt budget', () => {
    const window = createWindow()
    vi.mocked(window.webContents.disableDeviceEmulation).mockImplementation(() => {
      throw new Error('always fails')
    })
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS * (VIEWPORT_REFLOW_RESTORE_ATTEMPTS + 4))
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(
      VIEWPORT_REFLOW_RESTORE_ATTEMPTS + 1
    )

    // Why: an unbounded retry would pin the latch and silently kill every later reflow.
    vi.mocked(window.webContents.disableDeviceEmulation).mockImplementation(() => undefined)
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.enableDeviceEmulation).toHaveBeenCalledTimes(2)
  })

  it('abandons the restore once the webContents is gone', () => {
    const window = createWindow()
    vi.mocked(window.webContents.disableDeviceEmulation).mockImplementation(() => {
      throw new Error('always fails')
    })
    reflowRendererViewport(window)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS + 1)
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(1)

    // Why: a destroyed renderer takes its emulated viewport with it; retrying is pointless.
    vi.mocked(window.webContents.isDestroyed).mockReturnValue(true)
    vi.advanceTimersByTime(VIEWPORT_REFLOW_SETTLE_MS * 5)
    expect(window.webContents.disableDeviceEmulation).toHaveBeenCalledTimes(1)
  })
})
