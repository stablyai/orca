import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import type { AgentAwakeService } from '../agent-awake-service'
import { translateMain } from '../i18n/main-i18n'
import type {
  SettingsBackupApplyRequest,
  SettingsBackupExportRequest
} from '../../shared/settings-backup/settings-backup-types'
import { SettingsBackupService } from '../settings-backup/settings-backup-service'
import { SettingsRecoveryPointStore } from '../settings-backup/settings-recovery-points'
import { applySettingsWrite } from './settings-write'

const BACKUP_FILE_EXTENSIONS = ['json']

export function registerSettingsBackupHandlers(
  store: Store,
  agentAwakeService?: AgentAwakeService
): void {
  const service = new SettingsBackupService({
    getSettings: () => store.getSettings(),
    // Why: no origin id, so every open window (including the one that asked) hears the change.
    writeSettings: (update) => applySettingsWrite(store, update, { agentAwakeService }),
    recoveryPoints: new SettingsRecoveryPointStore(app.getPath('userData')),
    appVersion: app.getVersion(),
    platform: process.platform,
    now: () => new Date()
  })

  ipcMain.handle('settingsBackup:export', (event, request: SettingsBackupExportRequest) =>
    service.exportToFile(request, (defaultFileName) => chooseSavePath(event, defaultFileName))
  )
  ipcMain.handle('settingsBackup:previewImport', (event) =>
    service.previewImport(() => chooseOpenPath(event))
  )
  ipcMain.handle('settingsBackup:applyImport', (_event, request: SettingsBackupApplyRequest) =>
    service.applyImport(request)
  )
  ipcMain.handle('settingsBackup:listRecoveryPoints', () => service.listRecoveryPoints())
  ipcMain.handle('settingsBackup:restoreRecoveryPoint', (_event, args: { id?: unknown }) =>
    service.restoreRecoveryPoint(args?.id)
  )
}

function backupFileFilter(): Electron.FileFilter {
  return {
    name: translateMain('settingsBackup.dialog.fileFilter', 'Orca settings backup'),
    extensions: BACKUP_FILE_EXTENSIONS
  }
}

async function chooseSavePath(
  event: IpcMainInvokeEvent,
  defaultFileName: string
): Promise<string | null> {
  const options = {
    title: translateMain('settingsBackup.dialog.exportTitle', 'Export Orca settings'),
    defaultPath: defaultFileName,
    filters: [backupFileFilter()]
  } satisfies Electron.SaveDialogOptions
  const parent = BrowserWindow.fromWebContents(event.sender)
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function chooseOpenPath(event: IpcMainInvokeEvent): Promise<string | null> {
  const options = {
    title: translateMain('settingsBackup.dialog.importTitle', 'Import Orca settings'),
    properties: ['openFile'],
    filters: [backupFileFilter()]
  } satisfies Electron.OpenDialogOptions
  const parent = BrowserWindow.fromWebContents(event.sender)
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}
