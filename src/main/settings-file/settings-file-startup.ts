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

const DEFAULT_START_WAIT_MS = 2000

type StartOutcome = 'started' | 'failed' | 'slow'

// Resolves once file values are in the store, so nothing reads settings before they land.
// A broken or slow settings file or watcher must never block startup, so failures disable the feature
// and a start that outlasts the wait keeps finishing in the background.
export async function startUserSettingsFileSync(
  store: SettingsFileStore,
  homePath: string,
  options: { startWaitMs?: number } = {}
): Promise<SettingsFileSync | null> {
  const sync = createSettingsFileSync({
    filePath: getUserSettingsFilePath(homePath),
    store,
    defaults: getDefaultSettings(homePath),
    log: consoleLog
  })
  const starting = sync.start().then(
    (): StartOutcome => 'started',
    async (error): Promise<StartOutcome> => {
      consoleLog.warn(`disabled: ${error instanceof Error ? error.message : String(error)}`)
      // A disposed instance reports 'absent' and ignores calls, so a late failure leaves no half-started service behind.
      await sync.dispose().catch(() => undefined)
      return 'failed'
    }
  )
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<StartOutcome>((resolve) => {
    waitTimer = setTimeout(() => resolve('slow'), options.startWaitMs ?? DEFAULT_START_WAIT_MS)
  })
  const outcome = await Promise.race([starting, slow])
  clearTimeout(waitTimer)
  if (outcome === 'failed') {
    return null
  }
  if (outcome === 'slow') {
    consoleLog.warn('settings file start is slow; continuing in background')
  }
  return sync
}
