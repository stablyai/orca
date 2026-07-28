import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS,
  TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
} from '../../shared/terminal-tab-close'

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
    vi.useRealTimers()
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  it('waits for the targeted renderer durability acknowledgement', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
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

  it('propagates renderer cancellation instead of reporting success', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
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

  it('reserves response margin after the provider deadline', async () => {
    vi.useFakeTimers()
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const pending = requestTerminalTabCloseFromRenderer(
      { isDestroyed: () => false, webContents } as never,
      'tab-slow-provider'
    )
    let outcome = 'pending'
    void pending.then(
      () => {
        outcome = 'resolved'
      },
      (error: Error) => {
        outcome = error.message
      }
    )

    await vi.advanceTimersByTimeAsync(TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(
      TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS - TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS - 1
    )
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).rejects.toThrow('terminal_tab_close_timeout')
  })
})
