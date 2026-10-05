import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR,
  type TerminalChatViewRequest
} from '../../shared/terminal-chat-view-request'

const ipcEmitter = new EventEmitter()
const ipcMainMock = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.on(channel, listener)
  }),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.removeListener(channel, listener)
  })
}

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

function createMainWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    send: vi.fn()
  })
  const mainWindow = Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    webContents
  })
  return { mainWindow, webContents, window: asBrowserWindow(mainWindow) }
}

function asBrowserWindow(fake: EventEmitter): BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every BrowserWindow/webContents member the relay touches (isDestroyed, once, removeListener, send).
  return fake as unknown as BrowserWindow
}

function sentRequest(send: ReturnType<typeof vi.fn>): TerminalChatViewRequest {
  return send.mock.calls[0]?.[1]
}

const ARGS = {
  worktreeId: 'wt-1',
  tabId: 'tab-1',
  leafId: 'leaf-b',
  viewMode: 'chat' as const
}

describe('requestTerminalChatViewFromRenderer', () => {
  beforeEach(() => {
    vi.useRealTimers()
    ipcEmitter.removeAllListeners()
  })

  it('sends synchronously and resolves with the pair the renderer reports', async () => {
    const { requestTerminalChatViewFromRenderer } =
      await import('./terminal-chat-view-request-relay')
    const { window, webContents } = createMainWindow()
    const pending = requestTerminalChatViewFromRenderer(window, ARGS)
    // Why synchronous: the host's admit order must be the order the renderer applies.
    expect(webContents.send).toHaveBeenCalledOnce()
    const request = sentRequest(webContents.send)
    expect(request).toMatchObject(ARGS)

    ipcEmitter.emit(
      'ui:terminalChatViewResponse',
      { sender: {} },
      { requestId: request.requestId, chatView: { viewMode: 'terminal', chatLeafId: null } }
    )
    ipcEmitter.emit(
      'ui:terminalChatViewResponse',
      { sender: webContents },
      { requestId: request.requestId, chatView: { viewMode: 'chat', chatLeafId: 'leaf-b' } }
    )
    await expect(pending).resolves.toEqual({ viewMode: 'chat', chatLeafId: 'leaf-b' })
    expect(ipcEmitter.listenerCount('ui:terminalChatViewResponse')).toBe(0)
  })

  it('rejects when the renderer is unavailable', async () => {
    const { requestTerminalChatViewFromRenderer } =
      await import('./terminal-chat-view-request-relay')
    const { mainWindow, webContents, window } = createMainWindow()
    mainWindow.isDestroyed = () => true
    await expect(requestTerminalChatViewFromRenderer(window, ARGS)).rejects.toThrow(
      'renderer_unavailable'
    )
    expect(webContents.send).not.toHaveBeenCalled()

    const live = createMainWindow()
    const pending = requestTerminalChatViewFromRenderer(live.window, ARGS)
    live.webContents.emit('render-process-gone')
    await expect(pending).rejects.toThrow('renderer_unavailable')
  })

  it('reports a renderer that never answers within 10 s as chat_view_relay_timeout', async () => {
    vi.useFakeTimers()
    const { requestTerminalChatViewFromRenderer } =
      await import('./terminal-chat-view-request-relay')
    const { window } = createMainWindow()
    const pending = requestTerminalChatViewFromRenderer(window, ARGS)
    const assertion = expect(pending).rejects.toThrow('chat_view_relay_timeout')
    let settled = false
    void pending.catch(() => {}).finally(() => (settled = true))

    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await assertion
    expect(ipcEmitter.listenerCount('ui:terminalChatViewResponse')).toBe(0)
  })

  it('surfaces a renderer error reply', async () => {
    const { requestTerminalChatViewFromRenderer } =
      await import('./terminal-chat-view-request-relay')
    const { window, webContents } = createMainWindow()
    const pending = requestTerminalChatViewFromRenderer(window, ARGS)
    const request = sentRequest(webContents.send)
    ipcEmitter.emit(
      'ui:terminalChatViewResponse',
      { sender: webContents },
      { requestId: request.requestId, error: TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR }
    )
    await expect(pending).rejects.toThrow(TERMINAL_CHAT_VIEW_TAB_NOT_FOUND_ERROR)
  })
})
