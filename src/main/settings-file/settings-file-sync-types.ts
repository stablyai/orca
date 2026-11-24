import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { RebindingFileWatch } from '../ipc/filesystem/watcher-process/native-subscriptions/rebinding-file-watch'
import type {
  SettingsUpdateOptions,
  SettingsUpdateOrigin
} from '../persistence/applying-settings/settings-update'
import type { SettingsFileStatus } from '../../shared/settings/settings-file/settings-file-status-types'

export type {
  SettingsFileState,
  SettingsFileStatus
} from '../../shared/settings/settings-file/settings-file-status-types'

export type SettingsFileStore = {
  getSettings: () => GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>, options?: SettingsUpdateOptions) => unknown
  onSettingsPersisted: (
    listener: (changed: Partial<GlobalSettings>, origin: SettingsUpdateOrigin | undefined) => void
  ) => () => void
}

export type SettingsFileLog = {
  info: (message: string) => void
  warn: (message: string) => void
}

export type WatchSettingsFile = (
  path: string,
  onChange: () => void,
  onError: (error: Error) => void
) => RebindingFileWatch

export type SettingsFileSyncDeps = {
  filePath: string
  store: SettingsFileStore
  defaults: GlobalSettings
  watchFile?: WatchSettingsFile
  log: SettingsFileLog
  debounceMs?: number
  refreshIntervalMs?: number
}

export type SettingsFileSync = {
  start: () => Promise<void>
  refresh: () => Promise<void>
  flush: () => Promise<void>
  getStatus: () => SettingsFileStatus
  onStatusChanged: (listener: (status: SettingsFileStatus) => void) => () => void
  createFromCurrentSettings: () => Promise<SettingsFileStatus>
  dispose: () => Promise<void>
}
