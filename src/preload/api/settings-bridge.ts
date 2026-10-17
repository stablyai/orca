import { ipcRenderer } from 'electron'
import type { GhosttyImportPreview } from '../../shared/global-settings-types'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../../shared/terminal-custom-themes'
import type {
  SettingsBackupApplyRequest,
  SettingsBackupApplyResult,
  SettingsBackupExportRequest,
  SettingsBackupExportResult,
  SettingsBackupImportPreview,
  SettingsRecoveryPointSummary,
  SettingsRecoveryRestoreResult
} from '../../shared/settings-backup/settings-backup-types'
import type { PreloadApi } from '../api-types'

export const settingsApi = {
  get: () => ipcRenderer.invoke('settings:get'),

  // Why: blocking read for the few startup decisions (terminal side-effect authority) that can't wait for async hydration. Call sparingly.
  getSync: () => ipcRenderer.sendSync('settings:get-sync'),

  set: (args: Record<string, unknown>) => ipcRenderer.invoke('settings:set', args),

  setActiveRuntimeEnvironmentPreference: (args: { environmentId: string | null }) =>
    ipcRenderer.invoke('settings:set-active-runtime-environment-preference', args),

  updatePRBotAuthorOverride: (args: { author: string; isBot: boolean }) =>
    ipcRenderer.invoke('settings:update-pr-bot-author-override', args),

  listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:listFonts'),

  previewGhosttyImport: (): Promise<GhosttyImportPreview> =>
    ipcRenderer.invoke('settings:previewGhosttyImport'),

  previewWarpThemeImport: (source: WarpThemeImportSource): Promise<WarpThemeImportPreview> =>
    ipcRenderer.invoke('settings:previewWarpThemeImport', source),

  exportBackup: (request: SettingsBackupExportRequest): Promise<SettingsBackupExportResult> =>
    ipcRenderer.invoke('settingsBackup:export', request),

  previewBackupImport: (): Promise<SettingsBackupImportPreview> =>
    ipcRenderer.invoke('settingsBackup:previewImport'),

  applyBackupImport: (request: SettingsBackupApplyRequest): Promise<SettingsBackupApplyResult> =>
    ipcRenderer.invoke('settingsBackup:applyImport', request),

  listRecoveryPoints: (): Promise<SettingsRecoveryPointSummary[]> =>
    ipcRenderer.invoke('settingsBackup:listRecoveryPoints'),

  restoreRecoveryPoint: (id: string): Promise<SettingsRecoveryRestoreResult> =>
    ipcRenderer.invoke('settingsBackup:restoreRecoveryPoint', { id }),

  onChanged: (callback: (updates: Record<string, unknown>) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, updates: Record<string, unknown>): void =>
      callback(updates)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  }
} satisfies PreloadApi['settings']
