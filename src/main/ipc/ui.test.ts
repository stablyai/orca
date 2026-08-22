import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fromIdMock,
  fromWebContentsMock,
  getAllWebContentsMock,
  getAllWindowsMock,
  handleMock,
  onMock,
  removeAllListenersMock
} = vi.hoisted(() => ({
  fromIdMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  getAllWebContentsMock: vi.fn(),
  getAllWindowsMock: vi.fn(() => []),
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
    getAllWindows: getAllWindowsMock
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeAllListeners: removeAllListenersMock
  },
  webContents: {
    fromId: fromIdMock,
    getAllWebContents: getAllWebContentsMock
  }
}))

import {
  broadcastToTrustedUIRenderers,
  getTrustedUIRendererWindow,
  isTrustedUIRenderer,
  registerUIHandlers,
  sendToTrustedUIRenderer
} from './ui'
import { orcaWindowManager } from '../window/orca-window-manager'

function makeStore() {
  return {
    onUIChanged: vi.fn(),
    getUI: vi.fn(() => ({})),
    updateUI: vi.fn(),
    recordFeatureInteraction: vi.fn()
  }
}

function makeUIEvent(senderOverrides: Record<string, unknown> = {}): {
  sender: Record<string, unknown>
} {
  return {
    sender: {
      id: 17,
      getType: () => 'window',
      getURL: () => 'file:///orca/index.html',
      isDestroyed: () => false,
      ...senderOverrides
    }
  }
}

let nextWindowId = 1_000

function registerTrustedEvent(
  event: ReturnType<typeof makeUIEvent>,
  windowOverrides: Record<string, unknown> = {},
  role?: 'control' | 'secondary'
): Record<string, unknown> {
  const window = {
    id: nextWindowId++,
    webContents: event.sender,
    isDestroyed: () => false,
    ...windowOverrides
  }
  orcaWindowManager.register(window as never, role)
  return window
}

function clearTrustedWindows(): void {
  for (const window of orcaWindowManager.getAllWindows()) {
    orcaWindowManager.remove(window.id)
  }
}

function getNativePasteHandler():
  | ((event: ReturnType<typeof makeUIEvent>, options?: { mode?: unknown }) => void)
  | undefined {
  return onMock.mock.calls.find(([channel]) => channel === 'ui:performNativePaste')?.[1]
}

function getNativeSelectionActionHandler():
  | ((event: ReturnType<typeof makeUIEvent>, action: unknown) => void)
  | undefined {
  return onMock.mock.calls.find(([channel]) => channel === 'ui:performNativeSelectionAction')?.[1]
}

describe('UI IPC', () => {
  beforeEach(() => {
    clearTrustedWindows()
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    fromIdMock.mockReset()
    fromWebContentsMock.mockReset()
    getAllWebContentsMock.mockReset()
    getAllWebContentsMock.mockReturnValue([])
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    handleMock.mockReset()
    onMock.mockReset()
    removeAllListenersMock.mockReset()
  })

  afterEach(() => {
    clearTrustedWindows()
    vi.unstubAllEnvs()
  })

  it('separates control sends from trusted-window broadcasts', () => {
    const controlSender = {
      id: 901,
      getType: () => 'window',
      isDestroyed: () => false,
      send: vi.fn()
    }
    const secondarySender = {
      id: 902,
      getType: () => 'window',
      isDestroyed: () => false,
      send: vi.fn()
    }
    const makeWindow = (id: number, sender: typeof controlSender) => ({
      id,
      webContents: sender,
      isDestroyed: () => false
    })
    const control = makeWindow(801, controlSender)
    const secondary = makeWindow(802, secondarySender)
    orcaWindowManager.register(control as never, 'control')
    orcaWindowManager.register(secondary as never, 'secondary')

    try {
      expect(isTrustedUIRenderer(controlSender as never)).toBe(true)
      expect(isTrustedUIRenderer(secondarySender as never)).toBe(true)
      expect(isTrustedUIRenderer({ ...secondarySender, getType: () => 'webview' } as never)).toBe(
        false
      )
      expect(isTrustedUIRenderer({ ...secondarySender, id: 999, send: vi.fn() } as never)).toBe(
        false
      )

      sendToTrustedUIRenderer('control:event', { ok: true })
      broadcastToTrustedUIRenderers('broadcast:event', { ok: true })

      expect(controlSender.send).toHaveBeenCalledWith('control:event', { ok: true })
      expect(secondarySender.send).not.toHaveBeenCalledWith('control:event', { ok: true })
      expect(controlSender.send).toHaveBeenCalledWith('broadcast:event', { ok: true })
      expect(secondarySender.send).toHaveBeenCalledWith('broadcast:event', { ok: true })
    } finally {
      orcaWindowManager.remove(control.id)
      orcaWindowManager.remove(secondary.id)
    }
  })

  it('sends app events once to the trusted renderer without waking 100 browser guests', () => {
    const rendererSend = vi.fn()
    const event = makeUIEvent({ send: rendererSend })
    const guestSends = Array.from({ length: 100 }, () => vi.fn())
    getAllWebContentsMock.mockReturnValue(
      guestSends.map((send, index) => ({
        id: index + 100,
        isDestroyed: () => false,
        send
      }))
    )
    registerTrustedEvent(event, {}, 'control')

    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 1 })

    expect(rendererSend).toHaveBeenCalledOnce()
    expect(rendererSend).toHaveBeenCalledWith('gh:prRefreshEvent', { sequence: 1 })
    expect(getAllWebContentsMock).not.toHaveBeenCalled()
    expect(guestSends.reduce((total, send) => total + send.mock.calls.length, 0)).toBe(0)
  })

  it('resolves only the BrowserWindow that owns the trusted renderer', () => {
    let destroyed = false
    const event = makeUIEvent({ isDestroyed: () => destroyed })
    const mainWindow = registerTrustedEvent(event, { isDestroyed: () => destroyed }, 'control')

    expect(getTrustedUIRendererWindow()).toBe(mainWindow)

    destroyed = true
    expect(getTrustedUIRendererWindow()).toBeNull()
  })

  it('skips missing and originating renderers', () => {
    const rendererSend = vi.fn()
    const event = makeUIEvent({ send: rendererSend })
    const window = registerTrustedEvent(event, {}, 'control')

    sendToTrustedUIRenderer('gh:workItemMutated', { number: 7 }, 17)
    orcaWindowManager.remove(window.id as number)
    sendToTrustedUIRenderer('gh:workItemMutated', { number: 7 })

    expect(rendererSend).not.toHaveBeenCalled()
  })

  it('routes to a reopened window without retaining the closed renderer', () => {
    const oldRendererSend = vi.fn()
    const newRendererSend = vi.fn()
    const oldEvent = makeUIEvent({ id: 17, send: oldRendererSend })
    const oldWindow = registerTrustedEvent(oldEvent, {}, 'control')
    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 1 })

    orcaWindowManager.remove(oldWindow.id as number)
    const newEvent = makeUIEvent({ id: 42, send: newRendererSend })
    const newWindow = registerTrustedEvent(newEvent, {}, 'control')
    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 2 })

    orcaWindowManager.remove(newWindow.id as number)
    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 3 })

    expect(oldRendererSend).toHaveBeenCalledTimes(1)
    expect(newRendererSend).toHaveBeenCalledTimes(1)
    expect(newRendererSend).toHaveBeenCalledWith('gh:prRefreshEvent', { sequence: 2 })
  })

  it('trusts every explicitly registered Orca window renderer', () => {
    const first = makeUIEvent({ id: 17 })
    const second = makeUIEvent({ id: 42 })

    registerTrustedEvent(first, {}, 'control')
    registerTrustedEvent(second, {}, 'secondary')

    expect(isTrustedUIRenderer(first.sender as never)).toBe(true)
    expect(isTrustedUIRenderer(second.sender as never)).toBe(true)
  })

  it('does not trust an unregistered dev-server window by origin alone', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const sender = makeUIEvent({ getURL: () => 'http://localhost:5173/workspace' }).sender

    expect(isTrustedUIRenderer(sender as never)).toBe(false)
  })

  it('routes native paste fallback to the requesting webContents only', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    const event = makeUIEvent()
    const sender = event.sender
    registerTrustedEvent(event, {}, 'control')
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    expect(removeAllListenersMock).toHaveBeenCalledWith('ui:performNativePaste')
    const nativePasteHandler = getNativePasteHandler()
    nativePasteHandler?.(event)
    nativePasteHandler?.(event, { mode: 'paste-and-match-style' })

    expect(fromWebContentsMock).toHaveBeenCalledWith(sender)
    expect(paste).toHaveBeenCalledTimes(1)
    expect(pasteAndMatchStyle).toHaveBeenCalledTimes(1)
  })

  it('routes native selection fallbacks to the requesting webContents', () => {
    const copy = vi.fn()
    const selectAll = vi.fn()
    const event = makeUIEvent()
    registerTrustedEvent(event, {}, 'control')
    fromWebContentsMock.mockReturnValue({ webContents: { copy, selectAll } })

    registerUIHandlers(makeStore() as never)

    expect(removeAllListenersMock).toHaveBeenCalledWith('ui:performNativeSelectionAction')
    const handler = getNativeSelectionActionHandler()
    handler?.(event, 'copy')
    handler?.(event, 'select-all')
    handler?.(event, 'invalid')

    expect(copy).toHaveBeenCalledOnce()
    expect(selectAll).toHaveBeenCalledOnce()
  })

  it('reads maximized state from the requesting Orca window', () => {
    const first = makeUIEvent({ id: 17 })
    const second = makeUIEvent({ id: 42 })
    registerTrustedEvent(first, { isMaximized: () => false }, 'control')
    registerTrustedEvent(second, { isMaximized: () => true }, 'secondary')

    registerUIHandlers(makeStore() as never)

    const handler = handleMock.mock.calls.find(([channel]) => channel === 'window:isMaximized')?.[1]
    expect(handler).toBeTypeOf('function')
    expect(handler?.(first)).toBe(false)
    expect(handler?.(second)).toBe(true)
  })

  it('allows native selection fallback from the exact dashboard popout renderer', () => {
    const copy = vi.fn()
    const selectAll = vi.fn()
    const event = makeUIEvent({ id: 42 })
    const isDashboardPopoutRenderer = vi.fn((sender: unknown) => sender === event.sender)
    fromWebContentsMock.mockReturnValue({ webContents: { copy, selectAll } })

    registerUIHandlers(makeStore() as never, { isDashboardPopoutRenderer })

    const handler = getNativeSelectionActionHandler()
    handler?.(event, 'copy')
    handler?.(event, 'select-all')
    handler?.(makeUIEvent({ id: 43 }), 'copy')

    expect(isDashboardPopoutRenderer).toHaveBeenCalledWith(event.sender)
    expect(copy).toHaveBeenCalledOnce()
    expect(selectAll).toHaveBeenCalledOnce()
  })

  it('ignores native paste fallback from stale or browser senders', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    registerTrustedEvent(makeUIEvent(), {}, 'control')
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    const nativePasteHandler = getNativePasteHandler()
    nativePasteHandler?.(makeUIEvent({ id: 42 }))
    nativePasteHandler?.(makeUIEvent({ getType: () => 'webview' }))

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    expect(pasteAndMatchStyle).not.toHaveBeenCalled()
  })

  it('ignores native paste fallback from destroyed senders', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    const nativePasteHandler = getNativePasteHandler()
    nativePasteHandler?.(makeUIEvent({ isDestroyed: () => true }))

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    expect(pasteAndMatchStyle).not.toHaveBeenCalled()
  })

  it('rejects packaged file-url senders until the main window id is registered', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    const event = makeUIEvent()
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    getNativePasteHandler()?.(event)

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    expect(pasteAndMatchStyle).not.toHaveBeenCalled()
  })

  it('stops trusting a renderer only when its window is removed', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    const event = makeUIEvent()
    const window = registerTrustedEvent(event, {}, 'control')
    orcaWindowManager.remove(42)
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    getNativePasteHandler()?.(event)

    expect(paste).toHaveBeenCalledTimes(1)

    orcaWindowManager.remove(window.id as number)
    fromWebContentsMock.mockClear()
    paste.mockClear()

    getNativePasteHandler()?.(event)

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
  })

  it('allows native paste fallback only from an explicitly registered dev renderer', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    const event = makeUIEvent({ getURL: () => 'http://localhost:5173/workspace' })
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    registerTrustedEvent(event, {}, 'control')
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    const nativePasteHandler = getNativePasteHandler()
    nativePasteHandler?.(event)

    expect(fromWebContentsMock).toHaveBeenCalledWith(event.sender)
    expect(paste).toHaveBeenCalledTimes(1)

    fromWebContentsMock.mockClear()
    paste.mockClear()
    nativePasteHandler?.(
      makeUIEvent({ id: 18, getURL: () => 'http://localhost:5173/another-window' })
    )
    nativePasteHandler?.(makeUIEvent({ id: 19, getURL: () => 'http://127.0.0.1:5173/workspace' }))
    nativePasteHandler?.(makeUIEvent({ id: 20, getURL: () => 'file:///orca/index.html' }))

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    expect(pasteAndMatchStyle).not.toHaveBeenCalled()
  })
})
