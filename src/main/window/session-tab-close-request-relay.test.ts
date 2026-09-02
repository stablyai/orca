import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('requestSessionTabCloseFromRenderer', () => {
  beforeEach(() => {
    vi.useRealTimers()
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  it('waits for the targeted renderer acknowledgement', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')
    const request = webContents.send.mock.calls[0]?.[1] as {
      requestId: string
      tabId: string
      worktreeId: string
      expiresAt: number
    }

    expect(request).toMatchObject({ tabId: 'tab-1', worktreeId: 'wt-1' })
    expect(request.expiresAt).toBeGreaterThan(Date.now())
    ipcEmitter.emit('ui:sessionTabCloseResponse', { sender: {} }, { requestId: request.requestId })
    let settled = false
    void pending.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    ipcEmitter.emit(
      'ui:sessionTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId }
    )
    await expect(pending).resolves.toBeUndefined()
  })

  it('propagates renderer cancellation', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-pinned', 'wt-1')
    const request = webContents.send.mock.calls[0]?.[1] as { requestId: string }

    ipcEmitter.emit(
      'ui:sessionTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId, error: 'session_tab_close_canceled' }
    )

    await expect(pending).rejects.toThrow('session_tab_close_canceled')
  })

  it('rejects and releases listeners when the target window closes', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')

    mainWindow.emit('closed')

    await expect(pending).rejects.toThrow('renderer_unavailable')
    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-loading'])(
    'rejects when web contents emits %s',
    async (eventName) => {
      const { requestSessionTabCloseFromRenderer } =
        await import('./session-tab-close-request-relay')
      const { mainWindow, webContents } = createMainWindow()
      const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')

      webContents.emit(eventName)

      await expect(pending).rejects.toThrow('renderer_unavailable')
      expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
    }
  )

  it('times out after the renderer confirmation lease and response grace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')
    const request = webContents.send.mock.calls[0]?.[1] as { expiresAt: number }
    const rejection = expect(pending).rejects.toThrow('session_tab_close_timeout')

    await vi.advanceTimersByTimeAsync(request.expiresAt - Date.now() + 5_000)

    await rejection
    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
  })
})
