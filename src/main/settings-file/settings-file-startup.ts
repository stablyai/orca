import { getDefaultSettings } from '../../shared/orca-profiles/constants'
import { getUserSettingsFilePath } from './settings-file-path'
import { createSettingsFileSync } from './settings-file-sync'
import type {
  SettingsFileLog,
  SettingsFileStore,
  SettingsFileSync
} from './settings-file-sync-types'

const consoleLog: SettingsFileLog = {
  info: (message) => console.info(`[settings-file] ${message}`),
  warn: (message) => console.warn(`[settings-file] ${message}`)
}

// Resolves once file values are in the store, so nothing reads settings before they land.
// A broken settings file or watcher must never block startup, so failures disable the feature.
export async function startUserSettingsFileSync(
  store: SettingsFileStore,
  homePath: string
): Promise<SettingsFileSync | null> {
  const sync = createSettingsFileSync({
    filePath: getUserSettingsFilePath(homePath),
    store,
    defaults: getDefaultSettings(homePath),
    log: consoleLog
  })
  try {
    await sync.start()
    return sync
  } catch (error) {
    consoleLog.warn(`disabled: ${error instanceof Error ? error.message : String(error)}`)
    await sync.dispose().catch(() => undefined)
    return null
  }
}
