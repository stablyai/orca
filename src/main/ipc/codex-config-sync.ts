import { ipcMain } from 'electron'
import { join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { getCodexConfigSyncStatus } from '../codex/config-sync-stall'
import type { CodexConfigSyncStatus } from '../../shared/codex-config-sync-types'

/** The read-only slice of the runtime home service this channel needs. */
type CodexMirroredHomeResolver = {
  getMirroredHostHomePathForStatus: () => string | null
}

/** Registers the read-only IPC channel the settings pane reads once per mount for Codex config sync health. */
export function registerCodexConfigSyncHandlers(runtimeHome: CodexMirroredHomeResolver): void {
  ipcMain.removeHandler('codexConfigSync:status')
  ipcMain.handle('codexConfigSync:status', (): CodexConfigSyncStatus => {
    const systemHomePath = getSystemCodexHomePath()
    const runtimeHomePath = runtimeHome.getMirroredHostHomePathForStatus()
    if (!runtimeHomePath) {
      // Why: the system default runs Codex directly against ~/.codex, so there
      // is no mirror that can fall behind. Reporting on the shared home here
      // would warn about a config that lane never reads.
      return {
        state: 'synced',
        reason: null,
        systemConfigPath: join(systemHomePath, 'config.toml')
      }
    }
    return getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath })
  })
}
