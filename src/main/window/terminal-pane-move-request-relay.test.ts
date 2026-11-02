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
const moved: TerminalLeafMoveResult = { status: 'moved', ptyId: 'pty-1' }
const refused: TerminalLeafMoveResult = { status: 'refused', reason: 'pane_unavailable' }

function createMainWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    id: 1,
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
  const { requestTerminalPaneMoveFromRenderer } = await import('./terminal-pane-move-request-relay')
  const { commitFencedPaneMove } = await import('./terminal-pane-move-commit-fence')
  const { mainWindow, webContents } = createMainWindow()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the EventEmitter double implements the BrowserWindow members the relay uses.
  const pending = requestTerminalPaneMoveFromRenderer(mainWindow as never, move)
  const outcome = pending.then(
    (result) => result,
    (error: Error) => error.message
  )
  const sent: unknown = webContents.send.mock.calls[0]?.[1]
  const requestId =
    typeof sent === 'object' && sent !== null && 'requestId' in sent ? sent.requestId : null
  return {
    outcome,
    commit: (result: TerminalLeafMoveResult) => {
      const run = vi.fn(async () => result)
      return { run, committed: commitFencedPaneMove(webContents, move.targetTabId, run) }
    },
    reply: (result: TerminalLeafMoveResult) =>
      ipcEmitter.emit(
        'ui:terminalPaneMoveToNewTabReply',
        { sender: webContents },
        { requestId, result }
      ),
    passDeadline: () => vi.advanceTimersByTimeAsync(10_000),
    closeWindow: () => mainWindow.emit('closed')
  }
}

describe('requestTerminalPaneMoveFromRenderer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipcEmitter.removeAllListeners()
  })

  it('refuses a move the window has not committed by the deadline, and its late commit', async () => {
    const relay = await requestMove()
    await relay.passDeadline()
    await expect(relay.outcome).resolves.toBe('terminal_pane_move_timeout')
    expect(ipcEmitter.listenerCount('ui:terminalPaneMoveToNewTabReply')).toBe(0)

    const late = relay.commit(moved)
    await expect(late.committed).resolves.toEqual(refused)
    expect(late.run).not.toHaveBeenCalled()
  })

  it('answers with the reply of a window that committed, not the commit', async () => {
    const relay = await requestMove()
    await relay.commit(moved).committed
    relay.reply(refused)
    await expect(relay.outcome).resolves.toEqual(refused)
  })

  it.each([
    [
      'stays silent past the deadline',
      (relay: Awaited<ReturnType<typeof requestMove>>) => relay.passDeadline()
    ],
    ['goes away', (relay: Awaited<ReturnType<typeof requestMove>>) => relay.closeWindow()]
  ])('answers with the commit when the window %s after committing', async (_, end) => {
    const relay = await requestMove()
    await relay.commit(moved).committed
    await end(relay)
    await expect(relay.outcome).resolves.toEqual(moved)
  })

  it('rejects a move whose window goes away before committing', async () => {
    const relay = await requestMove()
    relay.closeWindow()
    await expect(relay.outcome).resolves.toBe('renderer_unavailable')
  })

  it('leaves a commit no client asked for alone', async () => {
    const { commitFencedPaneMove } = await import('./terminal-pane-move-commit-fence')
    const run = vi.fn(async (): Promise<TerminalLeafMoveResult> => moved)
    await expect(commitFencedPaneMove({ id: 2 }, 'tab-other', run)).resolves.toEqual(moved)
    expect(run).toHaveBeenCalledOnce()
  })
})
