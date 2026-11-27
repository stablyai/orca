// Window-only help for Settings › Google: read the team's app file (picked, or spotted landing in
// Downloads; Orca's own browser hands its download to main directly). Tokens never pass through here.
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { GOOGLE_CLIENT_FILE_MAX_BYTES } from '../../shared/google/google-client-config'
import type {
  GoogleSetupFileResult,
  GoogleSetupFoundKey
} from '../../shared/google/google-setup-ipc-types'
import { findGoogleKeyInFolder, watchFolderForGoogleKey } from '../google/google-key-download-watch'
const FindKeyArgs = lazyZodSchema(() =>
  z.object({
    since: z.number().nonnegative(),
    projectId: z.string().min(1).max(120).optional()
  })
)
const SaveArgs = lazyZodSchema(() =>
  z.object({
    text: z.string().min(1).max(GOOGLE_CLIENT_FILE_MAX_BYTES),
    name: z.string().regex(/^[\w.-]{1,120}$/)
  })
)

const TOO_LARGE = "This file is too large to be your team's Google app file."

async function readClientFile(path: string): Promise<GoogleSetupFileResult> {
  const info = await stat(path)
  if (info.size > GOOGLE_CLIENT_FILE_MAX_BYTES) {
    return { ok: false, message: TOO_LARGE }
  }
  return { ok: true, text: await readFile(path, 'utf8') }
}

async function pickClientFile(
  event: Electron.IpcMainInvokeEvent
): Promise<GoogleSetupFileResult | null> {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.OpenDialogOptions = {
    defaultPath: app.getPath('downloads'),
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  const picked = result.filePaths[0]
  return result.canceled || !picked ? null : readClientFile(picked)
}

/** Share with teammates: the save dialog at Downloads; false when the person cancels. */
async function saveAppFile(event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<boolean> {
  const { text, name } = SaveArgs.parse(raw)
  const parent = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath('downloads'), name),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) {
    return false
  }
  await writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 })
  return true
}

const downloadWatches = new Map<number, () => void>()

/** One Downloads watch per window; a new one replaces it. */
function watchDownloads(event: Electron.IpcMainInvokeEvent): Promise<GoogleSetupFileResult> {
  const id = event.sender.id
  downloadWatches.get(id)?.()
  const stop = new AbortController()
  const cancel = (): void => stop.abort()
  downloadWatches.set(id, cancel)
  return watchFolderForGoogleKey(app.getPath('downloads'), stop.signal).finally(() => {
    if (downloadWatches.get(id) === cancel) {
      downloadWatches.delete(id)
    }
  })
}

export function registerGoogleSetupHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler('googleSetup:pickClientFile')
    ipcMain.removeHandler('googleSetup:saveAppFile')
    ipcMain.removeHandler('googleSetup:watchDownloads')
    ipcMain.removeHandler('googleSetup:stopWatchingDownloads')
    ipcMain.removeHandler('googleSetup:findDownloadedKey')
  }
  ipc.handle('googleSetup:pickClientFile', (event) => pickClientFile(event))
  ipc.handle('googleSetup:saveAppFile', (event, raw: unknown) => saveAppFile(event, raw))
  ipc.handle('googleSetup:watchDownloads', (event) => watchDownloads(event))
  ipc.handle('googleSetup:stopWatchingDownloads', (event) => {
    downloadWatches.get(event.sender.id)?.()
  })
  ipc.handle(
    'googleSetup:findDownloadedKey',
    (_event, raw: unknown): Promise<GoogleSetupFoundKey | null> => {
      const { since, projectId } = FindKeyArgs.parse(raw)
      return findGoogleKeyInFolder(app.getPath('downloads'), {
        since,
        ...(projectId ? { projectId } : {})
      })
    }
  )
}
