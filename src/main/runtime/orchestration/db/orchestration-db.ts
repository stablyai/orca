import { CrewChanges } from '../crew/crew-changes'
import Database from '../../../sqlite/sync-database'
import { attachOrchestrationDbMethods } from './attach-orchestration-db-methods'
import type { MailHandBack } from './messages/helper-mailbox-hand-back'
import { hardenOrchestrationDatabaseFiles } from './database-file-permissions'
import { backfillFederatedStubHomeRuns } from './federation/federated-stub-home-run-backfill'
import type { OrchestrationDbMethods } from './orchestration-db-methods'
import {
  installRemovedWorkCapture,
  isRemovedWorkCaptureIntact
} from './reset/removed-orchestration-work-store'
import {
  createCoordinatorMailRoutingTrigger,
  createRunCoordinatorAddressTriggers,
  rememberCurrentRunCoordinatorHandles
} from './runs/run-coordinator-mail-routing'
import { createTables } from './schema/create-tables'
import { createPeerRunQueueTriggers } from './peer-runs/peer-run-queue-sql'
import { migrate } from './schema/migrate'
import { backfillStructuredWorkerOrcaSessionIds } from './schema/structured-worker-orca-session-backfill'
import { reconcileSettledWorkerDispatches } from './worker-dispatch/worker-dispatch-settlement'
import { refreshOutstandingDeliveryTrigger } from './schema/migrate-v41'

class OrchestrationDbCore {
  readonly crewChanges = new CrewChanges()
  db: Database.Database

  // Cache Dispatch emptiness to skip per-terminal queries on 16ms graph ticks for users without orchestration.
  hasAnyDispatchContextsCache: boolean | undefined
  localMutationCallerFingerprint: string | undefined
  // Restart recovery reads durable re-armed rows; only the post-transaction notification queue is in memory.
  pendingMailHandBacks: MailHandBack[] = []
  /** The runtime's wake for mail a settlement handed to a Run, called once the transaction ends. */
  mailHandBackListener: ((handBack: MailHandBack) => void) | undefined
  /** The runtime's auto-release timer, re-armed whenever a deadline moves. */
  workerTerminalAutoReleaseListener: (() => void) | undefined
  /** The user's auto-close switch; this runtime's choice also governs the remote workers it coordinates. */
  workerAutoReleaseEnabled: (() => boolean) | undefined

  constructor(dbPath: (string & {}) | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    // Truncate the WAL back to 8 MiB after a checkpoint, as the other app databases do; otherwise it stays at its high-water size.
    this.db.pragma('journal_size_limit = 8388608')
    // Savepoint journals otherwise need a temp file; a full or unwritable temp dir then aborts the whole transaction (#38123).
    this.db.pragma('temp_store = MEMORY')
    createTables.call(this as unknown as OrchestrationDb)
    // Read before migrate, which drops the capture triggers it may need to rebuild around.
    const removedWorkCaptureWasIntact = isRemovedWorkCaptureIntact(this.db)
    migrate.call(this as unknown as OrchestrationDb)
    refreshOutstandingDeliveryTrigger(this.db)
    for (const [table, columns] of [
      ['messages', ['answer_sender_snapshot']],
      ['federation_relay_items', ['answer_sender_report']]
    ] as const) {
      const existing = new Set(
        this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name)
      )
      for (const column of columns) {
        if (!existing.has(column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
        }
      }
    }
    createRunCoordinatorAddressTriggers(this.db)
    createPeerRunQueueTriggers(this.db)
    backfillFederatedStubHomeRuns(this.db)
    // After every open step that creates Runs, before any step that deletes work.
    installRemovedWorkCapture(this.db, removedWorkCaptureWasIntact)
    backfillStructuredWorkerOrcaSessionIds(this.db)
    this.db.exec(`
      DROP INDEX IF EXISTS idx_dispatch_creator_account_work;
      CREATE INDEX IF NOT EXISTS idx_dispatch_contexts_run ON dispatch_contexts(run_id);
      CREATE INDEX IF NOT EXISTS idx_question_threads_run ON question_threads(run_id);
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_origin
        ON worker_terminal_resources(origin_dispatch_id);
      CREATE INDEX IF NOT EXISTS idx_mutation_receipts_completed_age
        ON mutation_receipts(julianday(updated_at)) WHERE state = 'completed';
      CREATE INDEX IF NOT EXISTS idx_worker_dispatches_agent_terminal_handle
        ON worker_dispatches(agent_terminal_handle) WHERE agent_terminal_handle IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_attempt_observation_facts_liveness
        ON attempt_observation_facts(dispatch_id) WHERE facet = 'liveness';
      CREATE INDEX IF NOT EXISTS idx_dispatch_creator_mailbox_work
        ON dispatch_contexts(creator_dispatch_id, status);
      CREATE INDEX IF NOT EXISTS idx_runs_current_coordinator_handle ON runs(coordinator_handle);
      CREATE INDEX IF NOT EXISTS idx_messages_native_account_work
        ON messages(run_id, to_handle, type)
        WHERE read = 0 AND delivered_at IS NULL AND delivery_contract <> 'audit_only';
      CREATE INDEX IF NOT EXISTS idx_messages_native_direct_work
        ON messages(to_handle, type)
        WHERE read = 0 AND delivered_at IS NULL AND delivery_contract <> 'audit_only';
      CREATE INDEX IF NOT EXISTS idx_messages_stop_reports
        ON messages(run_id) WHERE id LIKE 'msg\\_stop\\_%' ESCAPE '\\';
    `)
    reconcileSettledWorkerDispatches(this.db)
    createCoordinatorMailRoutingTrigger.call(this as unknown as OrchestrationDb)
    rememberCurrentRunCoordinatorHandles.call(this as unknown as OrchestrationDb)
    hardenOrchestrationDatabaseFiles(dbPath)
  }

  close(): void {
    this.db.close()
  }
}

export type OrchestrationDb = OrchestrationDbCore & OrchestrationDbMethods

attachOrchestrationDbMethods(OrchestrationDbCore)

// Prototype installation supplies the methods modeled by this construct type.
export const OrchestrationDb = OrchestrationDbCore as new (
  dbPath: (string & {}) | ':memory:'
) => OrchestrationDb
