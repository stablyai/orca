import type { z } from 'zod'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { WorkerDockAcknowledge } from '../../../../shared/orchestration/dock/worker-dock'
import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'
import { workerDockSession } from './worker-dock-source'
import { OrchestrationError } from '../orchestration-error'

export function acknowledgeWorkerDock(
  db: OrchestrationDb,
  request: z.infer<typeof WorkerDockAcknowledge>
): void {
  const source = workerDockSession(request.party)
  let changed = false
  runLifecycleWriteTransaction(db.db, 'worker_dock_acknowledge', () => {
    for (const { dispatchId } of request.settlements) {
      if (db.getFederatedDispatch(dispatchId)) {
        throw new OrchestrationError(
          'remote_owner_actions_unsupported',
          'Stop or clear this from the computer it runs on.'
        )
      }
    }
    for (const { dispatchId, settlement } of request.settlements) {
      if (request.acknowledged) {
        const worker = db.db
          .prepare(`INSERT OR IGNORE INTO worker_dock_acknowledgments(source, dispatch_id, settlement)
          SELECT source, dispatch_id, settlement FROM worker_dock_facts
          WHERE source = ? AND dispatch_id = ? AND settlement = ? AND state IN ('failed', 'stopped', 'abandoned')`)
          .run(source, dispatchId, settlement)
        changed ||= worker.changes > 0
        if (db.workerDockSources.hasProviderFailures(source)) {
          const provider = db.db
            .prepare(`INSERT OR IGNORE INTO worker_dock_acknowledgments(source, dispatch_id, settlement)
            SELECT source, id, settlement FROM worker_dock_provider_failures
            WHERE source = ? AND id = ? AND settlement = ?`)
            .run(source, dispatchId, settlement)
          changed ||= provider.changes > 0
        }
      } else {
        const restored = db.db
          .prepare(
            `DELETE FROM worker_dock_acknowledgments WHERE source = ? AND dispatch_id = ? AND settlement = ?`
          )
          .run(source, dispatchId, settlement)
        changed ||= restored.changes > 0
      }
    }
  })
  if (changed) {
    db.workerDockSources.acknowledgmentChanged(source, !request.acknowledged)
  }
  db.crewChanges.notify(new Set(['topology']))
}
