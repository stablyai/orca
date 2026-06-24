import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getFocusedWindowMock, fromWebContentsMock, BrowserWindowMock } = vi.hoisted(() => {
  const getFocusedWindowMock = vi.fn()
  const fromWebContentsMock = vi.fn()
  class BrowserWindowMock {
    static getFocusedWindow = getFocusedWindowMock
    static fromWebContents = fromWebContentsMock
  }
  return { getFocusedWindowMock, fromWebContentsMock, BrowserWindowMock }
})

vi.mock('electron', () => ({
  BrowserWindow: BrowserWindowMock
}))

import {
  broadcastToMainWindows,
  focusOrOpenMainWindow,
  getFocusedOrLastActiveMainWindow,
  getLastActiveMainWindow,
  getMainWindowForWebContents,
  getMainWindows,
  getSingleMainWindow,
  hasLiveMainWindows,
  hasVisibleMainWindow,
  registerMainWindow
} from './main-window-registry'

type WindowStub = {
  id: number
  webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> }
  isDestroyed: ReturnType<typeof vi.fn>
  isVisible: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  handlers: Map<string, (() => void)[]>
}

function createWindow(id: number): WindowStub {
  const handlers = new Map<string, (() => void)[]>()
  return {
    id,
    webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    handlers,
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }),
    once: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }),
    removeListener: vi.fn((event: string, handler: () => void) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((entry) => entry !== handler)
      )
    })
  }
}

function emit(window: WindowStub, event: string): void {
  for (const handler of window.handlers.get(event) ?? []) {
    handler()
  }
}

describe('main-window-registry', () => {
  beforeEach(() => {
    getFocusedWindowMock.mockReset()
    fromWebContentsMock.mockReset()
    for (const window of getMainWindows()) {
      emit(window as never, 'closed')
    }
  })

  it('registers live windows and removes them on close', () => {
    const first = createWindow(1)
    const second = createWindow(2)

    registerMainWindow(first as never)
    registerMainWindow(second as never)

    expect(getMainWindows()).toEqual([first, second])

    emit(first, 'closed')

    expect(getMainWindows()).toEqual([second])
    expect(first.removeListener).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('tracks focus order and falls back when the focused window is not registered', () => {
    const first = createWindow(1)
    const second = createWindow(2)
    const unrelated = createWindow(3)

    registerMainWindow(first as never)
    registerMainWindow(second as never)
    emit(first, 'focus')
    getFocusedWindowMock.mockReturnValue(unrelated)

    expect(getFocusedOrLastActiveMainWindow()).toBe(first)

    getFocusedWindowMock.mockReturnValue(second)

    expect(getFocusedOrLastActiveMainWindow()).toBe(second)
  })

  it('filters destroyed windows from lookups and broadcasts', () => {
    const first = createWindow(1)
    const second = createWindow(2)
    first.isDestroyed.mockReturnValue(true)

    registerMainWindow(first as never)
    registerMainWindow(second as never)
    broadcastToMainWindows('agentStatus:set', { paneKey: 'pane-1' })

    expect(first.webContents.send).not.toHaveBeenCalled()
    expect(second.webContents.send).toHaveBeenCalledWith('agentStatus:set', { paneKey: 'pane-1' })
    expect(getLastActiveMainWindow()).toBe(second)
  })

  it('checks liveness and visibility without materializing window arrays', () => {
    const first = createWindow(1)
    const second = createWindow(2)
    first.isVisible.mockReturnValue(false)
    second.isMinimized.mockReturnValue(true)

    registerMainWindow(first as never)
    registerMainWindow(second as never)

    expect(hasLiveMainWindows()).toBe(true)
    expect(hasVisibleMainWindow()).toBe(false)
    second.isMinimized.mockReturnValue(false)
    expect(hasVisibleMainWindow()).toBe(true)
    expect(getSingleMainWindow()).toBeNull()

    emit(second, 'closed')
    expect(getSingleMainWindow()).toBe(first)
  })

  it('does not touch webContents after a window reports destroyed', () => {
    const send = vi.fn()
    const destroyedWindow = createWindow(9)
    destroyedWindow.isDestroyed.mockReturnValue(true)
    Object.defineProperty(destroyedWindow, 'webContents', {
      get(): never {
        throw new Error('webContents should not be read for destroyed windows')
      }
    })
    const liveWindow = createWindow(10)
    liveWindow.webContents.send = send

    registerMainWindow(destroyedWindow as never)
    registerMainWindow(liveWindow as never)

    broadcastToMainWindows('pty:data', { id: 'pty-1', data: 'x' })

    expect(send).toHaveBeenCalledWith('pty:data', { id: 'pty-1', data: 'x' })
  })

  it('resolves only registered BrowserWindow owners for webContents', () => {
    const first = createWindow(1)
    const unrelated = createWindow(9)
    registerMainWindow(first as never)

    fromWebContentsMock.mockReturnValue(first)
    expect(getMainWindowForWebContents(first.webContents as never)).toBe(first)

    fromWebContentsMock.mockReturnValue(unrelated)
    expect(getMainWindowForWebContents({} as never)).toBeNull()
  })

  it('focuses an existing live window or opens a new one', () => {
    const first = createWindow(1)
    const opened = createWindow(2)
    first.isMinimized.mockReturnValue(true)
    registerMainWindow(first as never)

    expect(focusOrOpenMainWindow(() => opened as never)).toBe(first)
    expect(first.restore).toHaveBeenCalled()
    expect(first.show).toHaveBeenCalled()
    expect(first.focus).toHaveBeenCalled()

    emit(first, 'closed')

    expect(focusOrOpenMainWindow(() => opened as never)).toBe(opened)
  })
})
