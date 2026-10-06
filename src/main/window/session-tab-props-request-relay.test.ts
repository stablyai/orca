import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionTabPropsWindow } from './session-tab-props-request-relay'

const listeners = new Map<string, (event: { sender: object }, response: unknown) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: { sender: object }, response: unknown) => void) =>
      listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel)
  }
}))

describe('requestSessionTabPropsFromRenderer', () => {
  afterEach(() => listeners.clear())

  it('waits for the targeted renderer response', async () => {
    const send = vi.fn((_: string, payload: { requestId: string }) => {
      queueMicrotask(() =>
        listeners.get('ui:sessionTabPropsResponse')?.({ sender: mainWindow.webContents }, payload)
      )
    })
    const mainWindow: SessionTabPropsWindow = {
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      webContents: { isDestroyed: () => false, send, once: vi.fn(), removeListener: vi.fn() }
    }
    const { requestSessionTabPropsFromRenderer } = await import('./session-tab-props-request-relay')

    await requestSessionTabPropsFromRenderer(mainWindow, 'tab-1', 'wt-1', {
      viewMode: 'chat'
    })

    expect(send).toHaveBeenCalledWith('ui:sessionTabPropsRequest', {
      requestId: expect.any(String),
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      viewMode: 'chat'
    })
  })

  it('rejects when the renderer reports a mutation failure', async () => {
    const mainWindow: SessionTabPropsWindow = {
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
      webContents: {
        isDestroyed: () => false,
        send: vi.fn((_: string, payload: { requestId: string }) => {
          queueMicrotask(() =>
            listeners.get('ui:sessionTabPropsResponse')?.(
              { sender: mainWindow.webContents },
              {
                requestId: payload.requestId,
                error: 'session_tab_not_found'
              }
            )
          )
        }),
        once: vi.fn(),
        removeListener: vi.fn()
      }
    }
    const { requestSessionTabPropsFromRenderer } = await import('./session-tab-props-request-relay')

    await expect(
      requestSessionTabPropsFromRenderer(mainWindow, 'missing', 'wt-1', {
        viewMode: 'chat'
      })
    ).rejects.toThrow('session_tab_not_found')
  })

  it('ignores unrelated responses and rejects after the renderer timeout', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn()
      const mainWindow: SessionTabPropsWindow = {
        isDestroyed: () => false,
        once: vi.fn(),
        removeListener: vi.fn(),
        webContents: { isDestroyed: () => false, send, once: vi.fn(), removeListener: vi.fn() }
      }
      const { requestSessionTabPropsFromRenderer } =
        await import('./session-tab-props-request-relay')
      const pending = requestSessionTabPropsFromRenderer(mainWindow, 'tab-1', 'wt-1', {})
      await Promise.resolve()
      const response = listeners.get('ui:sessionTabPropsResponse')
      response?.({ sender: {} }, { requestId: 'wrong-request' })
      response?.({ sender: mainWindow.webContents }, { requestId: 'wrong-request' })
      let settled = false
      void pending.catch(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).rejects.toThrow('renderer_timeout')
      expect(listeners.has('ui:sessionTabPropsResponse')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
