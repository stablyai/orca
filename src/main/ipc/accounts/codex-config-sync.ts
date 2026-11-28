import { ipcMain } from 'electron'
import { join } from 'node:path'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { getSystemCodexHomePath } from '../../codex/configuration/homes/codex-home-paths'
import { getCodexConfigSyncStatus } from '../../codex/configuration/settings/config-sync-stall'
import type { CodexConfigSyncStatus } from '../../../shared/agent-accounts/codex/codex-config-sync-types'
import type { CodexMirroredHomeStatus } from '../../codex-accounts/runtime-home/runtime-home-service-types'

/** The read-only slice of the runtime home service this channel needs. */
type CodexMirroredHomeResolver = {
  getMirroredHostHomePathForStatus: () => CodexMirroredHomeStatus
}

export function registerCodexConfigSyncHandlers(
  runtimeHome: CodexMirroredHomeResolver,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler('codexConfigSync:status')
  }
  ipc.handle('codexConfigSync:status', (): CodexConfigSyncStatus => {
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
