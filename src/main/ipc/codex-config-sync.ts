import { ipcMain } from 'electron'
import { join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { getCodexConfigSyncStatus } from '../codex/config-sync-stall'
import type { CodexConfigSyncStatus } from '../../shared/codex-config-sync-types'
import type { CodexMirroredHomeStatus } from '../codex-accounts/runtime-home-service'

/** The read-only slice of the runtime home service this channel needs. */
type CodexMirroredHomeResolver = {
  getMirroredHostHomePathForStatus: () => CodexMirroredHomeStatus
}

export function registerCodexConfigSyncHandlers(runtimeHome: CodexMirroredHomeResolver): void {
  ipcMain.removeHandler('codexConfigSync:status')
  ipcMain.handle('codexConfigSync:status', (): CodexConfigSyncStatus => {
    const systemHomePath = getSystemCodexHomePath()
    const mirrored = runtimeHome.getMirroredHostHomePathForStatus()
    if (mirrored.kind === 'unavailable') {
      // Return a stall: Settings catches thrown status errors and otherwise displays nothing.
      return {
        state: 'stalled',
        reason: 'managed-home-unavailable',
        systemConfigPath: join(systemHomePath, 'config.toml')
      }
    }
    const runtimeHomePath = mirrored.homePath
    if (!runtimeHomePath) {
      // System default reads ~/.codex directly; stale shared mirrors are irrelevant.
      return {
        state: 'synced',
        reason: null,
        systemConfigPath: join(systemHomePath, 'config.toml')
      }
    }
    return getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath })
  })
}
