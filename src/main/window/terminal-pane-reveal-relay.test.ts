import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it.each(['destroyed', 'render-process-gone', 'did-navigate', 'closed'])(
    'retires a pending reveal on %s and ignores its late reply',
    async (event) => {
      vi.useFakeTimers()
      const revealTerminalPaneInWindow = await loadRelay()
      const { webContents, mainWindow, windowEvents, sentRequest } = createWindow()
      let outcome: boolean | string | undefined
      const pending = revealTerminalPaneInWindow(mainWindow, target).then(
        (value) => (outcome = value),
        (error: Error) => (outcome = error.message)
      )

      ;(event === 'closed' ? windowEvents : webContents).emit(event)
      await Promise.resolve()
      await Promise.resolve()

      expect(outcome).toBe('renderer_unavailable')
      await pending
      reply(webContents, sentRequest().requestId, true)
      expect(mocks.focusExistingMainWindow).not.toHaveBeenCalled()
      expect(ipcEmitter.listenerCount('ui:terminalPaneRevealReply')).toBe(0)
      expect(webContents.eventNames()).toEqual([])
      expect(windowEvents.eventNames()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('shares listeners across a burst and preserves another window after retirement', async () => {
    vi.useFakeTimers()
    const revealTerminalPaneInWindow = await loadRelay()
    const retired = createWindow()
    const survivor = createWindow()
    const pending = Array.from({ length: 100 }, () =>
      revealTerminalPaneInWindow(retired.mainWindow, target).catch((error: Error) => error.message)
    )
    const live = revealTerminalPaneInWindow(survivor.mainWindow, target)
    expect(ipcEmitter.listenerCount('ui:terminalPaneRevealReply')).toBe(1)
    for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
      expect(retired.webContents.listenerCount(event)).toBe(1)
    }

    retired.webContents.emit('render-process-gone')
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 100 }, () => 'renderer_unavailable')
    )
    expect(retired.webContents.eventNames()).toEqual([])
    expect(retired.windowEvents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    reply(retired.webContents, retired.sentRequest().requestId, true)
    expect(mocks.focusExistingMainWindow).not.toHaveBeenCalled()
    reply(survivor.webContents, survivor.sentRequest().requestId, true)
    await expect(live).resolves.toBe(true)
    expect(mocks.focusExistingMainWindow).toHaveBeenCalledOnce()
    expect(ipcEmitter.listenerCount('ui:terminalPaneRevealReply')).toBe(0)
    expect(survivor.webContents.eventNames()).toEqual([])
    expect(survivor.windowEvents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps same-document navigation and an uncommitted navigation attempt live', async () => {
    const revealTerminalPaneInWindow = await loadRelay()
    const { webContents, mainWindow, sentRequest } = createWindow()
    const pending = revealTerminalPaneInWindow(mainWindow, target)
    webContents.emit('did-navigate-in-page', {}, '#section', true)
    webContents.emit('did-start-navigation', {}, 'https://external.test', false, true)
    reply(webContents, sentRequest().requestId, true)
    await expect(pending).resolves.toBe(true)
    expect(mocks.focusExistingMainWindow).toHaveBeenCalledOnce()
  })

  it('releases the request when sending to the renderer throws', async () => {
    vi.useFakeTimers()
    const revealTerminalPaneInWindow = await loadRelay()
    const { webContents, mainWindow, windowEvents } = createWindow()
    webContents.send.mockImplementation(() => {
      throw new Error('Render frame was disposed')
    })
    await expect(revealTerminalPaneInWindow(mainWindow, target)).rejects.toThrow(
      'renderer_unavailable'
    )
    expect(ipcEmitter.listenerCount('ui:terminalPaneRevealReply')).toBe(0)
    expect(webContents.eventNames()).toEqual([])
    expect(windowEvents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.focusExistingMainWindow).not.toHaveBeenCalled()
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
