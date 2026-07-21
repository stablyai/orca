import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('requestTerminalTabCloseFromRenderer', () => {
  beforeEach(() => {
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the targeted renderer durability acknowledgement', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./renderer-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const otherWebContents = {}
    const mainWindow = { isDestroyed: () => false, webContents }
    const pending = requestTerminalTabCloseFromRenderer(mainWindow as never, 'tab-1')
    const request = webContents.send.mock.calls[0]?.[1] as { requestId: string; tabId: string }

    expect(request.tabId).toBe('tab-1')
    ipcEmitter.emit(
      'ui:terminalTabCloseResponse',
      { sender: otherWebContents },
      { requestId: request.requestId }
    )
    let settled = false
    void pending.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    ipcEmitter.emit(
      'ui:terminalTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId }
    )
    await expect(pending).resolves.toBeUndefined()
  })

  it('waits for an acknowledged generic session-tab result', async () => {
    const { requestSessionTabCloseFromRenderer } =
      await import('./renderer-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const pending = requestSessionTabCloseFromRenderer(
      { isDestroyed: () => false, webContents } as never,
      'file-tab-1',
      'wt-1'
    )
    const request = webContents.send.mock.calls[0]?.[1] as {
      requestId: string
      tabId: string
      worktreeId: string
    }

    expect(request).toMatchObject({ tabId: 'file-tab-1', worktreeId: 'wt-1' })
    ipcEmitter.emit(
      'ui:sessionTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId, result: 'already-absent' }
    )

    await expect(pending).resolves.toBe('already-absent')
  })

  it('removes the response listener when the renderer does not acknowledge', async () => {
    vi.useFakeTimers()
    const { requestSessionTabCloseFromRenderer } =
      await import('./renderer-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const pending = requestSessionTabCloseFromRenderer(
      { isDestroyed: () => false, webContents } as never,
      'file-tab-1',
      'wt-1'
    )
    const rejected = expect(pending).rejects.toThrow('session_tab_close_timeout')

    await vi.advanceTimersByTimeAsync(20_000)

    await rejected
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      'ui:sessionTabCloseResponse',
      expect.any(Function)
    )
  })

  it('propagates renderer cancellation instead of reporting success', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./renderer-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const pending = requestTerminalTabCloseFromRenderer(
      { isDestroyed: () => false, webContents } as never,
      'tab-pinned'
    )
    const request = webContents.send.mock.calls[0]?.[1] as { requestId: string }

    ipcEmitter.emit(
      'ui:terminalTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId, error: 'terminal_tab_pinned' }
    )

    await expect(pending).rejects.toThrow('terminal_tab_pinned')
  })
})
