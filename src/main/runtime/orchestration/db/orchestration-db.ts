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
import { migrate } from './schema/migrate'
import { backfillStructuredWorkerOrcaSessionIds } from './schema/structured-worker-orca-session-backfill'
import { reconcileSettledWorkerDispatches } from './worker-dispatch/worker-dispatch-settlement'

class OrchestrationDbCore {
  db: Database.Database

  // Cache Dispatch emptiness to skip per-terminal queries on 16ms graph ticks for users without orchestration.
  hasAnyDispatchContextsCache: boolean | undefined
  localMutationCallerFingerprint: string | undefined
  // Restart recovery reads durable re-armed rows; only the post-transaction notification queue is in memory.
  pendingMailHandBacks: MailHandBack[] = []
  /** The runtime's wake for mail a settlement handed to a Run, called once the transaction ends. */
  mailHandBackListener: ((handBack: MailHandBack) => void) | undefined

  constructor(dbPath: (string & {}) | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    createTables.call(this as unknown as OrchestrationDb)
    // Read before migrate, which drops the capture triggers it may need to rebuild around.
    const removedWorkCaptureWasIntact = isRemovedWorkCaptureIntact(this.db)
    migrate.call(this as unknown as OrchestrationDb)
    createRunCoordinatorAddressTriggers(this.db)
    backfillFederatedStubHomeRuns(this.db)
    // After every open step that creates Runs, before any step that deletes work.
    installRemovedWorkCapture(this.db, removedWorkCaptureWasIntact)
    backfillStructuredWorkerOrcaSessionIds(this.db)
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
