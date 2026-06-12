import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import type { Store } from '../persistence'
import type { GlobalSettings, PersistedState } from '../../shared/types'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { listSystemFontFamilies } from '../system-fonts'
import { previewGhosttyImport } from '../ghostty/index'
import { previewWarpThemeImport } from '../warp-themes'
import type { AgentAwakeService } from '../agent-awake-service'
import { createSettingsUpdateApplier } from '../settings/apply-settings-updates'
import { applyPortableSettingsDocument } from '../settings/apply-portable-document'
import {
  createSettingsExportDocument,
  previewSettingsExportImport,
  readSettingsExportDocument,
  type SettingsExportResult,
  type SettingsImportPreview,
  type SettingsImportResult
} from '../../shared/settings-portability'

function getPortableKeybindingSnapshot(keybindings?: KeybindingService): unknown {
  const snapshot = keybindings?.getSnapshot()
  return snapshot
    ? {
        keybindings: snapshot.commonOverrides,
        platforms: snapshot.platformOverrides
      }
    : undefined
}

export function registerSettingsHandlers(
  store: Store,
  agentAwakeService?: AgentAwakeService,
  keybindings?: KeybindingService
): void {
  store.onSettingsChanged((updates, _settings, originWebContentsId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const isOrigin =
        originWebContentsId !== undefined && window.webContents.id === originWebContentsId
      if (!window.isDestroyed() && !isOrigin) {
        window.webContents.send('settings:changed', updates)
      }
    }
  })

  ipcMain.handle('settings:get', () => {
    return store.getSettings()
  })

  const applySettingsUpdates = createSettingsUpdateApplier(store, agentAwakeService)

  ipcMain.handle('settings:set', async (event, args: Partial<GlobalSettings>) => {
    return applySettingsUpdates(args, event.sender.id)
  })

  ipcMain.handle('settings:exportPortable', async (event): Promise<SettingsExportResult> => {
    try {
      const keybindingSnapshot = getPortableKeybindingSnapshot(keybindings)
      const document = createSettingsExportDocument(store.getSettings(), {
        keybindings: keybindingSnapshot
      })
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        defaultPath: 'orca-settings.json',
        filters: [{ name: 'Orca Settings', extensions: ['json'] }]
      }
      const { canceled, filePath } = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (canceled || !filePath) {
        return { success: false, cancelled: true }
      }
      await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      return {
        success: true,
        filePath,
        portableSettingCount: Object.keys(document.settings).length,
        includesKeybindings: document.keybindings !== undefined
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export settings'
      }
    }
  })

  const pickSettingsImportFile = async (
    event: Electron.IpcMainInvokeEvent
  ): Promise<string | undefined> => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Orca Settings', extensions: ['json'] }]
    }
    const { canceled, filePaths } = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const filePath = filePaths[0]
    return canceled || !filePath ? undefined : filePath
  }

  const readPortableSettingsFile = async (filePath: string): Promise<unknown> => {
    const raw = await readFile(filePath, 'utf8')
    try {
      return JSON.parse(raw) as unknown
    } catch {
      throw new Error('The selected file is not valid JSON.')
    }
  }

  ipcMain.handle(
    'settings:previewPortableImport',
    async (event): Promise<SettingsImportPreview> => {
      const emptyPreview = {
        portableSettingCount: 0,
        changedSettingKeys: [],
        skippedSettingKeys: [],
        includesKeybindings: false,
        changedKeybindings: false
      }
      try {
        const filePath = await pickSettingsImportFile(event)
        if (!filePath) {
          return { ok: false, cancelled: true, ...emptyPreview }
        }
        const parsed = await readPortableSettingsFile(filePath)
        return {
          ...previewSettingsExportImport(parsed, store.getSettings(), {
            currentKeybindings: getPortableKeybindingSnapshot(keybindings)
          }),
          filePath
        }
      } catch (error) {
        return {
          ok: false,
          ...emptyPreview,
          error: error instanceof Error ? error.message : 'Failed to preview settings import'
        }
      }
    }
  )

  // Why: import re-reads and re-validates the file the preview picked instead
  // of trusting renderer-cached contents, so a file edited between preview and
  // apply still goes through the portable allowlist.
  ipcMain.handle(
    'settings:importPortable',
    async (_event, filePath: unknown): Promise<SettingsImportResult> => {
      try {
        if (typeof filePath !== 'string' || filePath.length === 0) {
          return { success: false, error: 'No settings file selected.' }
        }
        const parsed = readSettingsExportDocument(await readPortableSettingsFile(filePath))
        if (!parsed.document) {
          return { success: false, error: parsed.error }
        }
        const applied = await applyPortableSettingsDocument(
          parsed.document,
          applySettingsUpdates,
          store.getSettings(),
          keybindings
        )
        return { success: true, ...applied }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to import settings'
        }
      }
    }
  )

  ipcMain.handle('settings:listFonts', () => {
    return listSystemFontFamilies()
  })

  ipcMain.handle('settings:previewGhosttyImport', () => {
    return previewGhosttyImport(store)
  })

  ipcMain.handle('settings:previewWarpThemeImport', (event, args?: unknown) => {
    const source = args === undefined ? { kind: 'auto' } : args
    return previewWarpThemeImport(store, source, event.sender)
  })

  ipcMain.handle('cache:getGitHub', () => {
    return store.getGitHubCache()
  })

  ipcMain.handle('cache:setGitHub', (_event, args: { cache: PersistedState['githubCache'] }) => {
    store.setGitHubCache(args.cache)
  })
}
