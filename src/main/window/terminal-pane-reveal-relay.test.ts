import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalPaneRevealRequest,
  TerminalPaneRevealTarget
} from '../../shared/workspace-layout/terminal-pane-reveal'
import type { FocusExistingMainWindowOptions } from './focus-existing-window'

const ipcEmitter = new EventEmitter()
const mocks = vi.hoisted(() => ({
  focusExistingMainWindow: vi.fn<(options: FocusExistingMainWindowOptions) => string>()
}))
const ipcMainMock = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.on(channel, listener)
  }),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.removeListener(channel, listener)
  })
}

vi.mock('electron', () => ({ app: {}, ipcMain: ipcMainMock }))
vi.mock('./focus-existing-window', () => ({
  focusExistingMainWindow: mocks.focusExistingMainWindow
}))

const target: TerminalPaneRevealTarget = {
  worktreeId: 'repo-1::/srv/app',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  executionHostId: 'runtime:env-1'
}

function createWindow(options: { rendererDestroyed?: boolean } = {}) {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => options.rendererDestroyed === true,
    send: vi.fn<(channel: string, request: TerminalPaneRevealRequest) => void>()
  })
  const windowEvents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the relay's window/contents event, destruction and send surface.
  const mainWindow = windowEvents as unknown as BrowserWindow
  const sentRequest = (): TerminalPaneRevealRequest => {
    const [channel, request] = webContents.send.mock.calls[0] ?? []
    expect(channel).toBe('ui:revealTerminalPane')
    return request ?? { ...target, requestId: '' }
  }
  return { webContents, mainWindow, windowEvents, sentRequest }
}

async function loadRelay() {
  return (await import('./terminal-pane-reveal-relay')).revealTerminalPaneInWindow
}

function reply(sender: unknown, requestId: string, revealed: boolean): void {
  ipcEmitter.emit('ui:terminalPaneRevealReply', { sender }, { requestId, revealed })
}

describe('revealTerminalPaneInWindow', () => {
  beforeEach(() => {
    ipcEmitter.removeAllListeners()
    mocks.focusExistingMainWindow.mockReset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('raises the window once the targeted renderer has revealed the pane', async () => {
    const revealTerminalPaneInWindow = await loadRelay()
    const { webContents, mainWindow, sentRequest } = createWindow()
    const pending = revealTerminalPaneInWindow(mainWindow, target)
    const { requestId } = sentRequest()
    expect(sentRequest()).toEqual({ ...target, requestId })

    // Visible request IDs confer no authority; only the targeted window can answer.
    reply({}, requestId, false)
    reply(webContents, 'other-request', false)
    reply(webContents, requestId, true)

    await expect(pending).resolves.toBe(true)
    expect(mocks.focusExistingMainWindow).toHaveBeenCalledTimes(1)
    const focus = mocks.focusExistingMainWindow.mock.calls[0]?.[0]
    expect(focus?.getWindow()).toBe(mainWindow)
    expect(focus?.canOpenWindow?.()).toBe(false)
    expect(ipcEmitter.listenerCount('ui:terminalPaneRevealReply')).toBe(0)
  })
})
