import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLeafMoveResult } from '../../shared/workspace-layout/terminal-leaf-move'

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

const move = { worktreeId: 'wt-1', sourceTabId: 'tab-1', targetTabId: 'tab-new', leafId: 'leaf-1' }

function createMainWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn<(channel: string, request: { requestId: string }) => void>()
  })
  const mainWindow = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents
  })
  return { mainWindow, webContents }
}

async function requestMove() {
  const relay = {
    ...(await import('./terminal-pane-move-request-relay')),
    ...(await import('./terminal-pane-move-commit-fence'))
  }
  const { mainWindow, webContents } = createMainWindow()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the EventEmitter double implements the BrowserWindow members the relay uses.
  const pending = relay.requestTerminalPaneMoveFromRenderer(mainWindow as never, move)
  const request = webContents.send.mock.calls[0]![1]
  const sender = webContents
  const reply = (result: TerminalLeafMoveResult): void => {
    ipcEmitter.emit(
      'ui:terminalPaneMoveToNewTabReply',
      { sender: webContents },
      { requestId: request.requestId, result }
    )
  }
  return { relay, pending, sender, webContents, reply }
}

function deferredCommit() {
  let finish: (result: TerminalLeafMoveResult) => void = () => {}
  const commit = (): Promise<TerminalLeafMoveResult> =>
    new Promise((resolve) => {
      finish = resolve
    })
  return { commit, finish: (result: TerminalLeafMoveResult) => finish(result) }
}

describe('requestTerminalPaneMoveFromRenderer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    ipcEmitter.removeAllListeners()
  })

  it('commits nothing the window tries after the client was told the move timed out', async () => {
    const { relay, pending, sender, reply } = await requestMove()
    const timedOut = expect(pending).rejects.toThrow('terminal_pane_move_timeout')
    await vi.advanceTimersByTimeAsync(10_000)
    await timedOut

    const commit = vi.fn(async (): Promise<TerminalLeafMoveResult> => ({
      status: 'moved',
      ptyId: 'pty-1'
    }))
    const late = await relay.commitRelayedPaneMove(sender, move.targetTabId, commit)

    expect(late).toEqual({ status: 'refused', reason: 'pane_unavailable' })
    expect(commit).not.toHaveBeenCalled()
    reply({ status: 'refused', reason: 'pane_unavailable' })
    expect(ipcEmitter.listenerCount('ui:terminalPaneMoveToNewTabReply')).toBe(0)
  })

  it('answers moved once the window commits, even when its reply comes after the deadline', async () => {
    const { relay, pending, sender } = await requestMove()
    const { commit, finish } = deferredCommit()
    const committing = relay.commitRelayedPaneMove(sender, move.targetTabId, commit)
    await vi.advanceTimersByTimeAsync(10_000)
    finish({ status: 'moved', ptyId: 'pty-1' })

    await expect(committing).resolves.toEqual({ status: 'moved', ptyId: 'pty-1' })
    await expect(pending).resolves.toEqual({ status: 'moved', ptyId: 'pty-1' })
  })

  it('answers with the commit when the window goes away while it commits', async () => {
    const { relay, pending, sender, webContents } = await requestMove()
    const { commit, finish } = deferredCommit()
    const committing = relay.commitRelayedPaneMove(sender, move.targetTabId, commit)
    webContents.emit('render-process-gone')
    finish({ status: 'moved', ptyId: 'pty-1' })

    await expect(committing).resolves.toEqual({ status: 'moved', ptyId: 'pty-1' })
    await expect(pending).resolves.toEqual({ status: 'moved', ptyId: 'pty-1' })
  })
})
