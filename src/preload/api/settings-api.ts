import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../../shared/terminal-custom-themes'
import type { GhosttyImportPreview, GlobalSettings } from '../../shared/global-settings-types'
import type {
  SettingsBackupApplyRequest,
  SettingsBackupApplyResult,
  SettingsBackupExportRequest,
  SettingsBackupExportResult,
  SettingsBackupImportPreview,
  SettingsRecoveryPointSummary,
  SettingsRecoveryRestoreResult
} from '../../shared/settings-backup/settings-backup-types'

export type SettingsApi = {
  get: () => Promise<GlobalSettings>
  /** Synchronous persisted-settings read for startup decisions that can't wait for async hydration. Blocking IPC — call sparingly. */
  getSync: () => GlobalSettings | null
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
  setActiveRuntimeEnvironmentPreference: (args: {
    environmentId: string | null
  }) => Promise<GlobalSettings>
  updatePRBotAuthorOverride: (args: { author: string; isBot: boolean }) => Promise<GlobalSettings>
  listFonts: () => Promise<string[]>
  previewGhosttyImport: () => Promise<GhosttyImportPreview>
  previewWarpThemeImport: (source: WarpThemeImportSource) => Promise<WarpThemeImportPreview>
  /** Desktop only: writes chosen settings groups to a file the user picks. Secrets are never included. */
  exportBackup: (request: SettingsBackupExportRequest) => Promise<SettingsBackupExportResult>
  /** Desktop only: reads a backup the user picks and diffs it against current settings; changes nothing. */
  previewBackupImport: () => Promise<SettingsBackupImportPreview>
  /** Applies the confirmed keys of the last preview after saving a recovery point. */
  applyBackupImport: (request: SettingsBackupApplyRequest) => Promise<SettingsBackupApplyResult>
  listRecoveryPoints: () => Promise<SettingsRecoveryPointSummary[]>
  restoreRecoveryPoint: (id: string) => Promise<SettingsRecoveryRestoreResult>
  /** Subscribe to out-of-band settings updates (e.g. View > Appearance toggles) to stay in sync with main. */
  onChanged: (callback: (updates: Partial<GlobalSettings>) => void) => () => void
}

export type KeybindingsApi = {
  get: () => Promise<KeybindingFileSnapshot>
  ensureFile: () => Promise<KeybindingFileSnapshot>
  setAction: (args: {
    actionId: KeybindingActionId
    bindings: string[] | null
  }) => Promise<KeybindingFileSnapshot>
  reload: () => Promise<KeybindingFileSnapshot>
  openFile: () => Promise<KeybindingFileSnapshot>
  revealFile: () => Promise<KeybindingFileSnapshot>
  onChanged: (callback: (snapshot: KeybindingFileSnapshot) => void) => () => void
}
