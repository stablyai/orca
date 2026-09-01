// Local preload IPC for Data recovery (runbook release requirement): migration
// status, retry, recovery-point inventory, and main-owned restore. Never a
// runtime RPC method; the renderer sees metadata only.

import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { DataRecoveryMigrationStatus } from '../../shared/data-recovery'
import { listRecoveryPoints, restoreRecoveryPoint } from '../data-recovery/recovery-points'

export function registerDataRecoveryHandlers(store: Store): void {
  ipcMain.handle(
    'dataRecovery:migrationStatus',
    (): DataRecoveryMigrationStatus => ({
      agentCatalogMigrationError: store.getAgentCatalogMigrationError(),
      agentCatalogSchemaTooNew: store.getAgentCatalogSchemaTooNew()
    })
  )

  ipcMain.handle('dataRecovery:retryAgentCatalogMigration', () =>
    store.retryAgentCatalogMigration()
  )

  ipcMain.handle('dataRecovery:listPoints', () => listRecoveryPoints(store.getDataFilePath()))

  ipcMain.handle('dataRecovery:restore', async (_event, args: { id?: unknown; mode?: unknown }) => {
    // The pinned pre-v1 point is only restorable as Prepare downgrade: a
    // restart would relaunch the v1 build and immediately re-migrate the
    // restored file, undoing the restore.
    if (args?.id !== 'agent-catalog-pre-v1' || args?.mode !== 'prepare-downgrade') {
      return { ok: false, error: 'Invalid restore request.' }
    }
    const result = await restoreRecoveryPoint(store, args.id)
    if (!result.ok) {
      return result
    }
    // Reply first, then quit without relaunching; the frozen store cannot
    // write over the restored file during shutdown.
    setImmediate(() => {
      app.quit()
    })
    return result
  })
}
