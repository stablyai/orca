import { app, ipcMain } from 'electron'
import type { MemorySnapshot } from '../../shared/types'
import type { Store } from '../persistence'
import { collectMemorySnapshot } from '../memory/collector'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

function isMemorySnapshot(value: unknown): value is MemorySnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return Array.isArray(record.worktrees) && typeof record.collectedAt === 'number'
}

/**
 * Resource Manager memory samples.
 *
 * When a runtime environment is focused (e.g. LXC1 via Orca serve), the local
 * Mac collector cannot see remote PTYs — by design it only samples this host.
 * Proxy `diagnostics.memory` to the active runtime so the Resource Manager
 * popover lists sessions/CPU/mem for the environment the user is actually using.
 */
export function registerMemoryHandlers(store: Store): void {
  ipcMain.handle('memory:getSnapshot', async (): Promise<MemorySnapshot> => {
    const environmentId = store.getSettings()?.activeRuntimeEnvironmentId?.trim()
    if (environmentId) {
      try {
        const response = await callRuntimeEnvironment(
          app.getPath('userData'),
          environmentId,
          'diagnostics.memory',
          null
        )
        if (response.ok === true && isMemorySnapshot(response.result)) {
          return response.result
        }
      } catch {
        // Fall through to the local collector so the popover still opens.
      }
    }
    return collectMemorySnapshot(store)
  })
}
