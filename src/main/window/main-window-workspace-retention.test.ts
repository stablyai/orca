import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const reveal = vi.hoisted(() => vi.fn())
vi.mock('./focus-existing-window', () => ({ safelyRevealWindow: reveal }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: {},
    dialog: {},
    shell: {},
    Menu: {},
    Notification: {},
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() })
  }
})
vi.mock('../i18n/main-i18n', () => ({ translateMain: vi.fn() }))
vi.mock('./main-window-visual-lifecycle', () => ({ syncTrafficLightPosition: vi.fn() }))

import { ipcMain } from 'electron'
import { installMainWindowCloseLifecycle } from './main-window-close-lifecycle'
import {
  authorizeWorkspaceWindowNativeBridge,
  isRetainedWorkspacePrimary
} from './workspace-window-native-bridge'

it.each(['native', 'window:request-close', 'window:confirm-close'])(
  'publishes the retention transition for %s without destroying the execution renderer',
  (channel) => {
    const secondary = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), {
        id: 20,
        setWindowOpenHandler: vi.fn()
      })
    })
    authorizeWorkspaceWindowNativeBridge(secondary as never, 'http://127.0.0.1:6768')
    const primary = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), { id: 10, send: vi.fn() }),
      hide: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
      isVisible: (): boolean => false,
      isDestroyed: () => false
    })
    const retained = vi.fn(() => expect(isRetainedWorkspacePrimary(primary as never)).toBe(true))
    primary.on('workspace-presentation-retained', retained)
    const lifecycle = installMainWindowCloseLifecycle({
      mainWindow: primary as never,
      rendererWebContentsId: 10,
      store: null,
      focus: {} as never,
      state: {} as never
    })
    try {
      expect(isRetainedWorkspacePrimary(primary as never)).toBe(false)
      if (channel === 'native') {
        const preventDefault = vi.fn()
        primary.emit('close', { preventDefault })
        expect(preventDefault).toHaveBeenCalledOnce()
      } else {
        ipcMain.emit(channel, { sender: primary.webContents })
      }
      expect(retained).toHaveBeenCalledOnce()
      expect(primary.hide).toHaveBeenCalledOnce()
      expect(primary.close).not.toHaveBeenCalled()
      expect(primary.destroy).not.toHaveBeenCalled()
      expect(primary.webContents.send).not.toHaveBeenCalledWith(
        'window:close-requested',
        expect.anything()
      )
      if (channel === 'window:confirm-close') {
        expect(primary.webContents.send).toHaveBeenCalledWith('window:unload-prevented')
      }
    } finally {
      lifecycle.dispose()
      secondary.emit('closed')
    }
    expect(reveal).toHaveBeenCalledWith(primary)
    expect(primary.close).toHaveBeenCalledOnce()
  }
)
