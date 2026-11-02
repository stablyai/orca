import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

const { ipcMain } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})
vi.mock('electron', () => ({ ipcMain }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('./renderer-document-navigation', () => ({ registerRendererDocumentNavigation: vi.fn() }))

import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

function attachWindow(id: number): {
  clientEvent: (event: RuntimeClientEvent) => void
  destroy: () => void
  notifier: RuntimeNotifier
  send: ReturnType<typeof vi.fn>
  webContents: object
} {
  let destroyed = false
  const send = vi.fn()
  const webContents = { isDestroyed: () => false, send, on: vi.fn() }
  const attached: {
    notifier: RuntimeNotifier | null
    clientEvent?: (event: RuntimeClientEvent) => void
  } = { notifier: null }
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
    onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
      attached.clientEvent = listener
      return () => {}
    },
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
  const { notifier, clientEvent } = attached
  if (!notifier || !clientEvent) {
    throw new Error('runtime notifier was not attached')
  }
  return {
    clientEvent,
    destroy: () => {
      destroyed = true
    },
    notifier,
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

describe('runtime window saved-restore fresh notice', () => {
  it('forwards only the live fresh-start event to the window', () => {
    const window = attachWindow(3)
    const event = {
      type: 'terminalSavedRestoreFresh' as const,
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      dispatchId: 'dispatch-1'
    }
    window.clientEvent(event)
    window.clientEvent({ type: 'reposChanged' })
    expect(window.send.mock.calls).toEqual([['runtime:terminalSavedRestoreFresh', event]])
  })
})
