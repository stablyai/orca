import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fromIdMock,
  fromWebContentsMock,
  getAllWebContentsMock,
  getAllWindowsMock,
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock
} = vi.hoisted(() => ({
  fromIdMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  getAllWebContentsMock: vi.fn(),
  getAllWindowsMock: vi.fn(() => []),
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
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
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  },
  webContents: {
    fromId: fromIdMock,
    getAllWebContents: getAllWebContentsMock
  }
}))

import {
  clearTrustedUIRendererWebContentsId,
  getTrustedUIRendererWindow,
  registerUIHandlers,
  sendToTrustedUIRenderer,
  setTrustedUIRendererWebContentsId
} from './ui'

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

function getNativePasteHandler():
  | ((event: ReturnType<typeof makeUIEvent>, options?: { mode?: unknown }) => void)
  | undefined {
  return onMock.mock.calls.find(([channel]) => channel === 'ui:performNativePaste')?.[1]
}

/** Exercises the registered invoke handler so its dispatch acknowledgement is covered. */
function getNativeSelectionActionHandler():
  | ((event: ReturnType<typeof makeUIEvent>, action: unknown) => boolean)
  | undefined {
  return handleMock.mock.calls.find(
    ([channel]) => channel === 'ui:performNativeSelectionAction'
  )?.[1]
}

describe('UI IPC', () => {
  beforeEach(() => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    fromIdMock.mockReset()
    fromWebContentsMock.mockReset()
    getAllWebContentsMock.mockReset()
    getAllWebContentsMock.mockReturnValue([])
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([])
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    setTrustedUIRendererWebContentsId(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sends app events once to the trusted renderer without waking 100 browser guests', () => {
    const rendererSend = vi.fn()
    const guestSends = Array.from({ length: 100 }, () => vi.fn())
    getAllWebContentsMock.mockReturnValue(
      guestSends.map((send, index) => ({
        id: index + 100,
        isDestroyed: () => false,
        send
      }))
    )
    fromIdMock.mockReturnValue({ id: 17, isDestroyed: () => false, send: rendererSend })
    setTrustedUIRendererWebContentsId(17)

    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 1 })

    expect(fromIdMock).toHaveBeenCalledOnce()
    expect(fromIdMock).toHaveBeenCalledWith(17)
    expect(rendererSend).toHaveBeenCalledOnce()
    expect(rendererSend).toHaveBeenCalledWith('gh:prRefreshEvent', { sequence: 1 })
    expect(getAllWebContentsMock).not.toHaveBeenCalled()
    expect(guestSends.reduce((total, send) => total + send.mock.calls.length, 0)).toBe(0)
  })

  it('resolves only the BrowserWindow that owns the trusted renderer', () => {
    const renderer = { id: 17, isDestroyed: () => false }
    const mainWindow = { id: 'main' }
    fromIdMock.mockReturnValue(renderer)
    fromWebContentsMock.mockReturnValue(mainWindow)
    setTrustedUIRendererWebContentsId(17)

    expect(getTrustedUIRendererWindow()).toBe(mainWindow)
    expect(fromWebContentsMock).toHaveBeenCalledWith(renderer)

    fromIdMock.mockReturnValue({ id: 17, isDestroyed: () => true })
    expect(getTrustedUIRendererWindow()).toBeNull()
  })

  it('skips missing, destroyed, and originating renderers', () => {
    const rendererSend = vi.fn()
    setTrustedUIRendererWebContentsId(17)

    fromIdMock.mockReturnValueOnce(undefined)
    sendToTrustedUIRenderer('gh:workItemMutated', { number: 7 })

    fromIdMock.mockReturnValueOnce({ id: 17, isDestroyed: () => true, send: rendererSend })
    sendToTrustedUIRenderer('gh:workItemMutated', { number: 7 })

    sendToTrustedUIRenderer('gh:workItemMutated', { number: 7 }, 17)

    expect(fromIdMock).toHaveBeenCalledTimes(2)
    expect(rendererSend).not.toHaveBeenCalled()
  })

  it('routes to a reopened window without retaining the closed renderer', () => {
    const oldRendererSend = vi.fn()
    const newRendererSend = vi.fn()
    fromIdMock.mockImplementation((id) =>
      id === 17
        ? { id, isDestroyed: () => false, send: oldRendererSend }
        : { id, isDestroyed: () => false, send: newRendererSend }
    )

    setTrustedUIRendererWebContentsId(17)
    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 1 })

    setTrustedUIRendererWebContentsId(42)
    clearTrustedUIRendererWebContentsId(17)
    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 2 })

    clearTrustedUIRendererWebContentsId(42)
    sendToTrustedUIRenderer('gh:prRefreshEvent', { sequence: 3 })

    expect(oldRendererSend).toHaveBeenCalledTimes(1)
    expect(newRendererSend).toHaveBeenCalledTimes(1)
    expect(newRendererSend).toHaveBeenCalledWith('gh:prRefreshEvent', { sequence: 2 })
  })

  it('routes native paste fallback to the requesting webContents only', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    const event = makeUIEvent()
    const sender = event.sender
    setTrustedUIRendererWebContentsId(17)
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
    setTrustedUIRendererWebContentsId(17)
    fromWebContentsMock.mockReturnValue({
      isDestroyed: () => false,
      webContents: { copy, selectAll, isDestroyed: () => false }
    })

    registerUIHandlers(makeStore() as never)

    expect(removeHandlerMock).toHaveBeenCalledWith('ui:performNativeSelectionAction')
    const handler = getNativeSelectionActionHandler()
    expect(handler?.(event, 'copy')).toBe(true)
    expect(handler?.(event, 'select-all')).toBe(true)
    expect(handler?.(event, 'invalid')).toBe(false)

    expect(fromWebContentsMock).toHaveBeenCalledWith(event.sender)
    expect(copy).toHaveBeenCalledOnce()
    expect(selectAll).toHaveBeenCalledOnce()
  })

  it('allows native selection fallback from the exact dashboard popout renderer', () => {
    const copy = vi.fn()
    const selectAll = vi.fn()
    const event = makeUIEvent({ id: 42 })
    const isDashboardPopoutRenderer = vi.fn((sender: unknown) => sender === event.sender)
    fromWebContentsMock.mockReturnValue({
      isDestroyed: () => false,
      webContents: { copy, selectAll, isDestroyed: () => false }
    })

    registerUIHandlers(makeStore() as never, { isDashboardPopoutRenderer })

    const handler = getNativeSelectionActionHandler()
    expect(handler?.(event, 'copy')).toBe(true)
    expect(handler?.(event, 'select-all')).toBe(true)
    expect(handler?.(makeUIEvent({ id: 43 }), 'copy')).toBe(false)

    expect(isDashboardPopoutRenderer).toHaveBeenCalledWith(event.sender)
    expect(copy).toHaveBeenCalledOnce()
    expect(selectAll).toHaveBeenCalledOnce()
  })

  it('rejects native selection actions from stale, browser, and destroyed senders', () => {
    setTrustedUIRendererWebContentsId(17)
    registerUIHandlers(makeStore() as never)
    const handler = getNativeSelectionActionHandler()

    expect(handler?.(makeUIEvent({ id: 42 }), 'copy')).toBe(false)
    expect(handler?.(makeUIEvent({ getType: () => 'webview' }), 'copy')).toBe(false)
    expect(handler?.(makeUIEvent({ isDestroyed: () => true }), 'copy')).toBe(false)
    expect(fromWebContentsMock).not.toHaveBeenCalled()
  })

  it('rejects destroyed dashboard senders even if the dashboard predicate accepts them', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler uses only the mocked Store methods.
    registerUIHandlers(makeStore() as never, { isDashboardPopoutRenderer: () => true })

    expect(
      getNativeSelectionActionHandler()?.(makeUIEvent({ isDestroyed: () => true }), 'copy')
    ).toBe(false)
    expect(fromWebContentsMock).not.toHaveBeenCalled()
  })

  it('returns false when the native selection window is missing or destroyed', () => {
    const copy = vi.fn()
    setTrustedUIRendererWebContentsId(17)
    registerUIHandlers(makeStore() as never)
    const handler = getNativeSelectionActionHandler()

    fromWebContentsMock.mockReturnValueOnce(null)
    expect(handler?.(makeUIEvent(), 'copy')).toBe(false)
    fromWebContentsMock.mockReturnValueOnce({
      isDestroyed: () => true,
      webContents: { copy, isDestroyed: () => false }
    })
    expect(handler?.(makeUIEvent(), 'copy')).toBe(false)
    fromWebContentsMock.mockReturnValueOnce({
      isDestroyed: () => false,
      webContents: { copy, isDestroyed: () => true }
    })
    expect(handler?.(makeUIEvent(), 'copy')).toBe(false)
    expect(copy).not.toHaveBeenCalled()
  })

  it('returns false if dispatching the native selection action throws', () => {
    setTrustedUIRendererWebContentsId(17)
    fromWebContentsMock.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        copy: vi.fn(() => {
          throw new Error('Object has been destroyed')
        })
      }
    })
    registerUIHandlers(makeStore() as never)

    expect(getNativeSelectionActionHandler()?.(makeUIEvent(), 'copy')).toBe(false)
  })

  it('ignores native paste fallback from stale or browser senders', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    setTrustedUIRendererWebContentsId(17)
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

  it('clears the trusted renderer id without clearing a newer window id', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    setTrustedUIRendererWebContentsId(17)
    clearTrustedUIRendererWebContentsId(42)
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    getNativePasteHandler()?.(makeUIEvent())

    expect(paste).toHaveBeenCalledTimes(1)

    clearTrustedUIRendererWebContentsId(17)
    fromWebContentsMock.mockClear()
    paste.mockClear()

    getNativePasteHandler()?.(makeUIEvent())

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
  })

  it('allows native paste fallback only from the configured dev renderer origin', () => {
    const paste = vi.fn()
    const pasteAndMatchStyle = vi.fn()
    const event = makeUIEvent({ getURL: () => 'http://localhost:5173/workspace' })
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    fromWebContentsMock.mockReturnValue({ webContents: { paste, pasteAndMatchStyle } })

    registerUIHandlers(makeStore() as never)

    const nativePasteHandler = getNativePasteHandler()
    nativePasteHandler?.(event)

    expect(fromWebContentsMock).toHaveBeenCalledWith(event.sender)
    expect(paste).toHaveBeenCalledTimes(1)

    fromWebContentsMock.mockClear()
    paste.mockClear()
    nativePasteHandler?.(makeUIEvent({ getURL: () => 'http://127.0.0.1:5173/workspace' }))
    nativePasteHandler?.(makeUIEvent({ getURL: () => 'file:///orca/index.html' }))
    nativePasteHandler?.(makeUIEvent({ getURL: () => 'not a url' }))

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    expect(pasteAndMatchStyle).not.toHaveBeenCalled()
  })
})
