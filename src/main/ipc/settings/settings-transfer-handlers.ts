import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Store } from '../../persistence/loading-store/store'
import {
  buildPortableSettingsFile,
  parsePortableSettingsFile,
  type SettingsExportResult,
  type SettingsImportReadResult
} from '../../../shared/settings/portable-settings'

// A real export is a few KB; refuse anything that could not be one before reading it into memory.
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024
const JSON_FILTERS = [{ name: 'JSON', extensions: ['json'] }]

function parentWindow(sender: WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined
}

export function registerSettingsTransferHandlers(store: Store): void {
  ipcMain.handle('settings:exportToFile', async (event): Promise<SettingsExportResult> => {
    const file = buildPortableSettingsFile(store.getSettings(), new Date())
    const parent = parentWindow(event.sender)
    const options = { defaultPath: 'orca-settings.json', filters: JSON_FILTERS }
    const { canceled, filePath } = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (canceled || !filePath) {
      return { status: 'cancelled' }
    }
    try {
      await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn('[settings] failed to write settings export:', error)
      return { status: 'failed' }
    }
    return { status: 'saved', filePath, settingCount: Object.keys(file.settings).length }
  })

  // Only reads and validates; the renderer applies through settings:set so every write side effect runs.
  ipcMain.handle('settings:readImportFile', async (event): Promise<SettingsImportReadResult> => {
    const parent = parentWindow(event.sender)
    const options = { properties: ['openFile' as const], filters: JSON_FILTERS }
    const { canceled, filePaths } = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const filePath = filePaths[0]
    if (canceled || !filePath) {
      return { status: 'cancelled' }
    }
    let text: string
    try {
      if ((await stat(filePath)).size > MAX_IMPORT_FILE_BYTES) {
        return { status: 'failed', reason: 'too-large' }
      }
      text = await readFile(filePath, 'utf8')
    } catch {
      return { status: 'failed', reason: 'unreadable' }
    }
    const parsed = parsePortableSettingsFile(text)
    if (!parsed.ok) {
      return { status: 'failed', reason: parsed.reason }
    }
    return { status: 'loaded', settings: parsed.settings, ignoredKeys: parsed.ignoredKeys }
  })
}
