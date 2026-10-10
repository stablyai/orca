import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionTabPropsWindow } from './session-tab-props-request-relay'
import { requestSessionTabPropsFromRenderer } from './session-tab-props-request-relay'
import { uiTerminalAndSessionTabsApi } from '../../preload/api/ui-bridge-terminal-and-session-tabs'

const mainListeners = new Map<string, (event: { sender: object }, payload: unknown) => void>()
const rendererListeners = new Map<string, (event: unknown, payload: unknown) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: { sender: object }, payload: unknown) => void) =>
      mainListeners.set(channel, listener),
    removeListener: (channel: string) => mainListeners.delete(channel)
  },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
      rendererListeners.set(channel, listener),
    removeListener: (channel: string) => rendererListeners.delete(channel),
    send: (channel: string, payload: unknown) =>
      mainListeners.get(channel)?.({ sender: webContents }, payload)
  }
}))

const webContents = {
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => rendererListeners.get(channel)?.({}, payload),
  once: vi.fn(),
  removeListener: vi.fn()
}

describe('session tab props relay/preload contract', () => {
  afterEach(() => {
    mainListeners.clear()
    rendererListeners.clear()
    vi.clearAllMocks()
  })

  it('delivers the real request to preload and returns its ACK to the targeted relay', async () => {
    const mainWindow: SessionTabPropsWindow = {
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      webContents
    }
    const received = vi.fn()
    const unsubscribe = uiTerminalAndSessionTabsApi.onSetSessionTabProps((payload) => {
      received(payload)
      uiTerminalAndSessionTabsApi.respondSessionTabProps({ requestId: payload.requestId })
    })

    await requestSessionTabPropsFromRenderer(mainWindow, 'tab-1', 'wt-1', { viewMode: 'chat' })

    expect(received).toHaveBeenCalledWith({
      requestId: expect.any(String),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      viewMode: 'chat'
    })
    unsubscribe()
  })
})
