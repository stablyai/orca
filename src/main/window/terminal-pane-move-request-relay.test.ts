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
    isDestroyed: () => false,
    send: vi.fn()
  })
  const mainWindow = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents
  })
  return { mainWindow, webContents }
}

async function requestMove() {
  const relay = await import('./terminal-pane-move-request-relay')
  const { mainWindow, webContents } = createMainWindow()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the EventEmitter double implements the BrowserWindow members the relay uses.
  const pending = relay.requestTerminalPaneMoveFromRenderer(mainWindow as never, move)
  const request = webContents.send.mock.calls[0]?.[1] as { requestId: string }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay compares the sender by identity only.
  const sender = webContents as never
  const reply = (result: TerminalLeafMoveResult): void => {
    ipcEmitter.emit(
      'ui:terminalPaneMoveToNewTabReply',
      { sender: webContents },
      { requestId: request.requestId, result }
    )
  }
  return { relay, pending, sender, reply }
}

describe('requestTerminalPaneMoveFromRenderer', () => {
  beforeEach(() => {
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

  it.each<TerminalLeafMoveResult>([
    { status: 'moved', ptyId: 'pty-1' },
    { status: 'refused', reason: 'pane_unavailable' }
  ])(
    'answers with the window’s final reply once it commits, past the deadline (%o)',
    async (windowReply) => {
      const { relay, pending, sender, reply } = await requestMove()
      let finishCommit: (result: TerminalLeafMoveResult) => void = () => {}
      const committing = relay.commitRelayedPaneMove(
        sender,
        move.targetTabId,
        () =>
          new Promise((resolve) => {
            finishCommit = resolve
          })
      )
      await vi.advanceTimersByTimeAsync(10_000)
      finishCommit({ status: 'moved', ptyId: 'pty-1' })
      await expect(committing).resolves.toEqual({ status: 'moved', ptyId: 'pty-1' })
      await vi.advanceTimersByTimeAsync(10_000)

      reply(windowReply)
      await expect(pending).resolves.toEqual(windowReply)
    }
  )

  it('leaves a commit no client asked for alone', async () => {
    const { relay, sender } = await requestMove()
    const commit = vi.fn(async (): Promise<TerminalLeafMoveResult> => ({
      status: 'moved',
      ptyId: null
    }))

    await expect(relay.commitRelayedPaneMove(sender, 'tab-other', commit)).resolves.toEqual({
      status: 'moved',
      ptyId: null
    })
    expect(commit).toHaveBeenCalledOnce()
  })
})
