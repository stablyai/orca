import fs from 'node:fs/promises'
import path from 'node:path'

import { app, clipboard, ipcMain, nativeImage, session } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import type { CreateWorktreeResult } from '../../shared/types'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import { registerRepoHandlers } from '../ipc/repos'
import { registerWorktreeHandlers } from '../ipc/worktrees'
import { registerPtyHandlers } from '../ipc/pty'
import { browserManager } from '../browser/browser-manager'
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
  runtime: OrcaRuntimeService,
  getSelectedCodexHomePath?: () => string | null
): void {
  registerRepoHandlers(mainWindow, store)
  registerWorktreeHandlers(mainWindow, store)
  registerPtyHandlers(mainWindow, runtime, getSelectedCodexHomePath)
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

  const browserSession = session.fromPartition(ORCA_BROWSER_PARTITION)
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Why: the in-app browser is for dev previews and lightweight browsing, not
    // trusted desktop-app privileges. Denying by default keeps arbitrary sites
    // from silently escalating into camera/mic/notification prompts inside Orca.
    callback(permission === 'fullscreen')
  })
  browserSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'fullscreen'
  })
  browserSession.setDisplayMediaRequestHandler((_request, callback) => {
    // Why: arbitrary sites inside Orca should never be able to capture the
    // desktop or application windows until there is explicit product UX for
    // selecting a source and surfacing that choice to the user.
    // Why: pass undefined (not null) to satisfy Electron's typed callback
    // signature while still denying the request.
    callback({ video: undefined, audio: undefined })
  })
  browserSession.on('will-download', (event) => {
    // Why: browser-tab downloads need explicit product UX before arbitrary sites
    // can write files through Orca. Until that exists, cancel downloads instead
    // of inheriting Electron's default save behavior invisibly.
    event.preventDefault()
  })

  mainWindow.on('closed', () => {
    // Why: parked browser webviews can outlive the visible tab body until the
    // renderer process exits. Clearing main-owned guest registrations on window
    // close prevents stale tab→webContents ids from leaking across app relaunch
    // or hot-reload cycles.
    browserManager.unregisterAll()
  })
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
  ipcMain.removeHandler('clipboard:writeImage')
  ipcMain.removeHandler('clipboard:saveImageAsTempFile')

  ipcMain.handle('clipboard:readText', () => clipboard.readText())
  // Why: terminals need to detect clipboard images to support tools like Claude
  // Code that accept image input via paste. Writes the clipboard image to a
  // temp file and returns the path, or null if the clipboard has no image.
  ipcMain.handle('clipboard:saveImageAsTempFile', async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) {
      return null
    }
    const tempPath = path.join(app.getPath('temp'), `orca-paste-${Date.now()}.png`)
    await fs.writeFile(tempPath, image.toPNG())
    return tempPath
  })
  ipcMain.handle('clipboard:writeText', (_event, text: string) => clipboard.writeText(text))
  ipcMain.handle('clipboard:writeImage', (_event, dataUrl: string) => {
    // Why: only accept validated PNG data URIs to prevent writing arbitrary
    // data to the clipboard. The renderer already validates the prefix, but
    // defense-in-depth applies here too.
    const prefix = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
      return
    }
    // Why: use createFromBuffer instead of createFromDataURL — the latter
    // silently returns an empty image on some macOS + Electron combinations
    // when the data URL is large (>500KB). Decoding the base64 manually and
    // using createFromBuffer is more reliable.
    const buffer = Buffer.from(dataUrl.slice(prefix.length), 'base64')
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) {
      return
    }
    clipboard.writeImage(image)
  })
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
