import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalPaneRevealRequest,
  TerminalPaneRevealTarget
} from '../../shared/terminal-pane-reveal'
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
  const webContents = {
    isDestroyed: () => options.rendererDestroyed === true,
    send: vi.fn<(channel: string, request: TerminalPaneRevealRequest) => void>()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay reads only isDestroyed and these two webContents members.
  const mainWindow = { isDestroyed: () => false, webContents } as unknown as BrowserWindow
  const sentRequest = (): TerminalPaneRevealRequest => {
    const [channel, request] = webContents.send.mock.calls[0] ?? []
    expect(channel).toBe('ui:revealTerminalPane')
    return request ?? { ...target, requestId: '' }
  }
  return { webContents, mainWindow, sentRequest }
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

  it('raises the window once the targeted renderer has revealed the pane', async () => {
    const revealTerminalPaneInWindow = await loadRelay()
    const { webContents, mainWindow, sentRequest } = createWindow()
    const pending = revealTerminalPaneInWindow(mainWindow, target)
    const { requestId } = sentRequest()
    expect(sentRequest()).toEqual({ ...target, requestId })

    // Why: request ids are readable by any renderer, so only the targeted window may answer.
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

  it('leaves the window where it is when the renderer does not know the workspace', async () => {
    const revealTerminalPaneInWindow = await loadRelay()
    const { webContents, mainWindow, sentRequest } = createWindow()
    const pending = revealTerminalPaneInWindow(mainWindow, target)

    reply(webContents, sentRequest().requestId, false)

    await expect(pending).resolves.toBe(false)
    expect(mocks.focusExistingMainWindow).not.toHaveBeenCalled()
  })

  it('fails instead of waiting when the window is gone', async () => {
    const revealTerminalPaneInWindow = await loadRelay()
    const { webContents, mainWindow } = createWindow({ rendererDestroyed: true })

    await expect(revealTerminalPaneInWindow(mainWindow, target)).rejects.toThrow(
      'renderer_unavailable'
    )
    expect(webContents.send).not.toHaveBeenCalled()
  })

  it('times out when the renderer never answers', async () => {
    vi.useFakeTimers()
    try {
      const revealTerminalPaneInWindow = await loadRelay()
      const { mainWindow } = createWindow()
      const assertion = expect(revealTerminalPaneInWindow(mainWindow, target)).rejects.toThrow(
        'terminal_reveal_timeout'
      )

      await vi.advanceTimersByTimeAsync(10_000)

      await assertion
      expect(ipcEmitter.listenerCount('ui:terminalPaneRevealReply')).toBe(0)
      expect(mocks.focusExistingMainWindow).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
