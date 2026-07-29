import { beforeEach, describe, expect, it, vi } from 'vitest'

const { onMock, removeListenerMock } = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeListenerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: onMock,
    removeListener: removeListenerMock
  }
}))

import { rollbackMismatchedTerminalGridAppend } from './terminal-grid-append-rollback-relay'

describe('terminal grid append mismatch rollback', () => {
  beforeEach(() => {
    onMock.mockReset()
    removeListenerMock.mockReset()
  })

  it('rolls back the renderer reply identity before rejecting the mismatch', async () => {
    const webContents = { send: vi.fn() }
    const mainWindow = { webContents }
    const rejection = rollbackMismatchedTerminalGridAppend(mainWindow as never, {
      transactionId: 'transaction-1',
      tabId: 'actual-tab',
      leafId: 'actual-leaf'
    })
    const rollbackPayload = webContents.send.mock.calls[0]![1]
    const replyHandler = onMock.mock.calls[0]![1]

    expect(webContents.send).toHaveBeenCalledWith('ui:rollbackTerminalGridAppend', {
      requestId: expect.any(String),
      transactionId: 'transaction-1',
      tabId: 'actual-tab',
      leafId: 'actual-leaf'
    })

    replyHandler(
      { sender: webContents },
      {
        requestId: rollbackPayload.requestId
      }
    )

    await expect(rejection).rejects.toThrow('did not match its staged identity')
    expect(removeListenerMock).toHaveBeenCalledWith(
      'terminal:gridAppendRollbackReply',
      replyHandler
    )
  })
})
