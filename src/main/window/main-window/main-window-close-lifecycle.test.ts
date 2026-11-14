import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { ipcMainMock } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMainMock: Object.assign(new EventEmitter(), {
      handle: vi.fn(),
      removeHandler: vi.fn()
    })
  }
})
vi.mock('electron', () => ({
  ipcMain: ipcMainMock,
  Menu: { getApplicationMenu: () => null },
  Notification: vi.fn()
}))
vi.mock('../../i18n/main-i18n', () => ({ translateMain: (_key: string, text: string) => text }))
vi.mock('./main-window-visual-lifecycle', () => ({ syncTrafficLightPosition: vi.fn() }))

import { installMainWindowCloseLifecycle } from './main-window-close-lifecycle'

const RENDERER_ID = 7

function install(): {
  mainWindow: EventEmitter & { close: ReturnType<typeof vi.fn> }
  dispose: () => void
} {
  const mainWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn(), isCrashed: () => false }),
    isDestroyed: () => false,
    close: vi.fn()
  })
  const { dispose } = installMainWindowCloseLifecycle({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close lifecycle reads only isRendererProcessGone from focus.
    focus: { isRendererProcessGone: () => false } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the BrowserWindow surface the close lifecycle uses.
    mainWindow: mainWindow as never,
    rendererWebContentsId: RENDERER_ID,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the confirm path calls none of the state lifecycle hooks.
    state: { freezeBoundsOnQuit: vi.fn(), resumeBoundsPersistence: vi.fn() } as never,
    store: null
  })
  return { mainWindow, dispose }
}

let disposeLifecycle: (() => void) | null = null

beforeEach(() => {
  ipcMainMock.removeAllListeners()
})
afterEach(() => {
  disposeLifecycle?.()
  disposeLifecycle = null
})

it('a close confirm from another renderer leaves the main window open', () => {
  const { mainWindow, dispose } = install()
  disposeLifecycle = dispose

  ipcMainMock.emit('window:confirm-close', { sender: { id: RENDERER_ID + 1 } })
  expect(mainWindow.close).not.toHaveBeenCalled()

  ipcMainMock.emit('window:confirm-close', { sender: { id: RENDERER_ID } })
  expect(mainWindow.close).toHaveBeenCalledTimes(1)
})
