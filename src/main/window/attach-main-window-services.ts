import { app, clipboard, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import type { CreateWorktreeResult } from '../../shared/types'
import { registerRepoHandlers } from '../ipc/repos'
import { registerWorktreeHandlers } from '../ipc/worktrees'
import { registerPtyHandlers } from '../ipc/pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  checkForUpdatesFromMenu,
  downloadUpdate,
  getUpdateStatus,
  quitAndInstall,
  setupAutoUpdater
} from '../updater'

export function attachMainWindowServices(
  mainWindow: BrowserWindow,
  store: Store,
  runtime: OrcaRuntimeService
): void {
  registerRepoHandlers(mainWindow, store)
  registerWorktreeHandlers(mainWindow, store)
  registerPtyHandlers(mainWindow, runtime)
  registerFileDropRelay(mainWindow)
  setupAutoUpdater(mainWindow, {
    getLastUpdateCheckAt: () => store.getUI().lastUpdateCheckAt,
    onBeforeQuit: () => store.flush(),
    setLastUpdateCheckAt: (timestamp) => {
      store.updateUI({ lastUpdateCheckAt: timestamp })
    }
  })
  registerRuntimeWindowLifecycle(mainWindow, runtime)

  const allowedPermissions = new Set(['media', 'fullscreen', 'pointerLock'])
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(allowedPermissions.has(permission))
    }
  )
}

function registerRuntimeWindowLifecycle(
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService
): void {
  runtime.attachWindow(mainWindow.id)
  runtime.setNotifier({
    worktreesChanged: (repoId) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('worktrees:changed', { repoId })
      }
    },
    reposChanged: () => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('repos:changed')
      }
    },
    activateWorktree: (repoId, worktreeId, setup?: CreateWorktreeResult['setup']) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ui:activateWorktree', { repoId, worktreeId, setup })
      }
    }
  })
  // Why: the runtime must fail closed while the renderer graph is being torn
  // down or rebuilt, otherwise future CLI calls could act on stale terminal
  // mappings during reload transitions.
  mainWindow.webContents.on('did-start-loading', () => {
    runtime.markRendererReloading(mainWindow.id)
  })
  mainWindow.on('closed', () => {
    runtime.markGraphUnavailable(mainWindow.id)
  })
}

function registerFileDropRelay(mainWindow: BrowserWindow): void {
  ipcMain.removeAllListeners('terminal:file-dropped-from-preload')
  ipcMain.on(
    'terminal:file-dropped-from-preload',
    (_event, args: { paths: string[]; target: 'editor' | 'terminal' }) => {
      if (mainWindow.isDestroyed()) {
        return
      }

      for (const path of args.paths) {
        mainWindow.webContents.send('terminal:file-drop', { path, target: args.target })
      }
    }
  )
}

export function registerClipboardHandlers(): void {
  ipcMain.removeHandler('clipboard:readText')
  ipcMain.removeHandler('clipboard:writeText')

  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  ipcMain.handle('clipboard:writeText', (_event, text: string) => clipboard.writeText(text))
}

export function registerUpdaterHandlers(_store: Store): void {
  ipcMain.removeHandler('updater:getStatus')
  ipcMain.removeHandler('updater:getVersion')
  ipcMain.removeHandler('updater:check')
  ipcMain.removeHandler('updater:download')
  ipcMain.removeHandler('updater:quitAndInstall')

  ipcMain.handle('updater:getStatus', () => getUpdateStatus())
  ipcMain.handle('updater:getVersion', () => app.getVersion())
  ipcMain.handle('updater:check', () => checkForUpdatesFromMenu())
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:quitAndInstall', () => quitAndInstall())
}
