import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'

const { ipcMain } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})
vi.mock('electron', () => ({ ipcMain }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('./renderer-document-navigation', () => ({ registerRendererDocumentNavigation: vi.fn() }))

import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

function attachWindow(id: number): {
  destroy: () => void
  notifier: RuntimeNotifier
  send: ReturnType<typeof vi.fn>
  webContents: object
} {
  let destroyed = false
  const send = vi.fn()
  const webContents = { isDestroyed: () => false, send, on: vi.fn() }
  const attached: { notifier: RuntimeNotifier | null } = { notifier: null }
  const mainWindow = {
    id,
    isDestroyed: () => destroyed,
    on: vi.fn(),
    // Electron's BrowserWindow getter throws once the native window is gone.
    get webContents() {
      if (destroyed) {
        throw new TypeError('Object has been destroyed')
      }
      return webContents
    }
  }
  const runtime = {
    attachWindow: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    setNotifier: (next: RuntimeNotifier | null) => {
      attached.notifier = next
    }
  }
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only reads id, isDestroyed, on and webContents.
    mainWindow as unknown as BrowserWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only calls the stubbed runtime members.
    runtime as unknown as OrcaRuntimeService
  )
  if (!attached.notifier) {
    throw new Error('runtime notifier was not attached')
  }
  return {
    destroy: () => {
      destroyed = true
    },
    notifier: attached.notifier,
    send,
    webContents
  }
}

describe('runtime window terminal reveal', () => {
  it('lets a replacement window answer while a closed window still has a pending reveal', async () => {
    vi.useFakeTimers()
    try {
      const closedWindow = attachWindow(1)
      const stale = Promise.resolve(
        closedWindow.notifier.revealTerminalSession?.('wt-1', { ptyId: 'pty-1' })
      )
      const staleSettled = expect(stale).rejects.toThrow('Terminal reveal timed out')
      closedWindow.destroy()

      const nextWindow = attachWindow(2)
      const reveal = nextWindow.notifier.revealTerminalSession?.('wt-1', { ptyId: 'pty-2' })
      const [, payload] = nextWindow.send.mock.calls[0]

      expect(() =>
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: nextWindow.webContents },
          { requestId: payload.requestId, tabId: 'tab-2' }
        )
      ).not.toThrow()
      await expect(reveal).resolves.toEqual({ tabId: 'tab-2', title: undefined })

      await vi.advanceTimersByTimeAsync(10_000)
      await staleSettled
      expect(ipcMain.listenerCount('terminal:tabCreateReply')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
