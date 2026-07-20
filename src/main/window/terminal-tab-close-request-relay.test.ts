import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_TAB_CLOSE_RENDERER_TIMEOUT_MS,
  TERMINAL_TAB_CLOSE_RUNTIME_RPC_TIMEOUT_MS
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
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  it('keeps the outer runtime RPC budget above renderer adjudication', () => {
    expect(TERMINAL_TAB_CLOSE_RUNTIME_RPC_TIMEOUT_MS).toBeGreaterThan(
      TERMINAL_TAB_CLOSE_RENDERER_TIMEOUT_MS
    )
  })

  it('waits for the targeted renderer durability acknowledgement', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const otherWebContents = {}
    const mainWindow = { isDestroyed: () => false, webContents }
    const pending = requestTerminalTabCloseFromRenderer(mainWindow as never, 'tab-1', {
      validateOnly: true,
      expectedPtyIds: ['pty-1']
    })
    const request = webContents.send.mock.calls[0]?.[1] as {
      requestId: string
      tabId: string
      validateOnly?: boolean
      expectedPtyIds?: string[]
    }

    expect(request.tabId).toBe('tab-1')
    expect(request.validateOnly).toBe(true)
    expect(request.expectedPtyIds).toEqual(['pty-1'])
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
})
