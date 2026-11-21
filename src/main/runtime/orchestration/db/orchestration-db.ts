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
import { installWorkerStatusNotice, type DispatchRowChange } from './worker-status-notice'
import { refreshOutstandingDeliveryTrigger } from './schema/migrate-v41'
import { revokeAgentSessionPublicationFences } from '../../agent-session/agent-session-publication-fence'
import { RUN_PANE_KEY_MATCH_SUFFIX_SQL } from './pane-key-match'
import { installWorkerTerminalPriorOwnerIndex } from './worker-terminal/worker-terminal-prior-owner-index'
import { UNRELEASED_MINTED_WORKER_TERMINAL_SQL } from './worker-terminal/worker-terminal-release'

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
  /** Told, with its id, of every change to what places or shows a Dispatch (see worker-status-notice),
   *  by any writer; bots' chats trees and Activity re-read on it. */
  workerStatusListener: ((dispatchId: string | null, change: DispatchRowChange) => void) | undefined
  /** Set by a crew-notified mutation while it runs, to learn which Dispatches it wrote. */
  crewDispatchNotice: ((dispatchId: string | null, change: DispatchRowChange) => void) | undefined
  /** Told of the creating chat session whenever one of its Dispatches or workers is written. */
  sessionWorkersListener: ((sessionId: string) => void) | undefined
  /** Told when a paired server's answer for these Dispatches' workers changed; no row was written. */
  federatedWorkersListener: ((dispatchIds: readonly string[]) => void) | undefined
  private closed = false
  private readonly closeListeners = new Set<() => void>()
  private changedDispatchIds: Set<string> | null = null
  /** The user's auto-close switch; this runtime's choice also governs the remote workers it coordinates. */
  workerAutoReleaseEnabled: (() => boolean) | undefined

  constructor(dbPath: (string & {}) | ':memory:') {
    this.db = new Database(dbPath)
    // First, so opening beside another connection's checkpoint waits rather than failing.
    this.db.pragma('busy_timeout = 5000')
    // Before WAL and any table, so a new file returns free pages in bounded steps; an existing one needs a VACUUM.
    this.db.pragma('auto_vacuum = INCREMENTAL')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    // Truncate the WAL back to 8 MiB after a checkpoint, as the other app databases do; otherwise it stays at its high-water size.
    this.db.pragma('journal_size_limit = 8388608')
    // Savepoint journals otherwise need a temp file; a full or unwritable temp dir then aborts the whole transaction (#38123).
    this.db.pragma('temp_store = MEMORY')
    // The 2 MiB default makes every worker-list scan re-read its pages (#40821).
    this.db.pragma('cache_size = -65536')
    createTables.call(this as unknown as OrchestrationDb)
    // Read before migrate, which drops the capture triggers it may need to rebuild around.
    const removedWorkCaptureWasIntact = isRemovedWorkCaptureIntact(this.db)
    migrate.call(this as unknown as OrchestrationDb)
    refreshOutstandingDeliveryTrigger(this.db)
    installWorkerTerminalPriorOwnerIndex(this)
    for (const [table, columns] of [
      ['messages', ['answer_sender_snapshot']],
      ['federation_relay_items', ['answer_sender_report']],
      ['message_dispatch_provenance', ['sender_snapshot']]
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
      CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_unreleased_minted
        ON worker_terminal_resources(owner_dispatch_id) WHERE ${UNRELEASED_MINTED_WORKER_TERMINAL_SQL};
      CREATE INDEX IF NOT EXISTS idx_attempt_observation_facts_task
        ON attempt_observation_facts(task_id);
      CREATE INDEX IF NOT EXISTS idx_message_dispatch_provenance_dispatch
        ON message_dispatch_provenance(dispatch_id);
      CREATE INDEX IF NOT EXISTS idx_remote_run_links_run ON remote_run_links(run_id);
      CREATE INDEX IF NOT EXISTS idx_remote_placements_run ON remote_placements(run_id);
      CREATE INDEX IF NOT EXISTS idx_worker_dispatches_agent_terminal_handle
        ON worker_dispatches(agent_terminal_handle) WHERE agent_terminal_handle IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_attempt_observation_facts_liveness
        ON attempt_observation_facts(dispatch_id) WHERE facet = 'liveness';
      CREATE INDEX IF NOT EXISTS idx_dispatch_creator_mailbox_work
        ON dispatch_contexts(creator_dispatch_id, status);
      CREATE INDEX IF NOT EXISTS idx_runs_current_coordinator_handle ON runs(coordinator_handle);
      CREATE INDEX IF NOT EXISTS idx_runs_current_pane_exact
        ON runs(coordinator_pane_key) WHERE legacy = 0 AND coordinator_pane_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_current_pane_leaf
        ON runs(${RUN_PANE_KEY_MATCH_SUFFIX_SQL})
        WHERE legacy = 0 AND coordinator_pane_key IS NOT NULL
          AND instr(coordinator_pane_key, ':') > 1;
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
    installWorkerStatusNotice(this.db, (dispatchId, change) => {
      if (dispatchId) {
        revokeAgentSessionPublicationFences([JSON.stringify(['worker', dispatchId])])
      }
      this.workerStatusListener?.(dispatchId, change)
      this.crewDispatchNotice?.(dispatchId, change)
      if (dispatchId) {
        this.noteWorkerChanged(dispatchId)
      }
    })
    hardenOrchestrationDatabaseFiles(dbPath)
  }

  /** After the writes that fired it, so the read sees committed rows and never runs inside a trigger;
   *  one read per Dispatch per tick, one notice per session. */
  private noteWorkerChanged(dispatchId: string): void {
    if (!this.sessionWorkersListener) {
      return
    }
    if (this.changedDispatchIds) {
      this.changedDispatchIds.add(dispatchId)
      return
    }
    const changed = new Set([dispatchId])
    this.changedDispatchIds = changed
    queueMicrotask(() => {
      this.changedDispatchIds = null
      if (this.closed) {
        return
      }
      const db = this as unknown as OrchestrationDb
      const sessions = new Set<string>()
      for (const id of changed) {
        const sessionId = db.getDispatchContextById(id)?.creator_orca_session_id
        if (sessionId) {
          sessions.add(sessionId)
        }
      }
      for (const sessionId of sessions) {
        this.sessionWorkersListener?.(sessionId)
      }
    })
  }

  /** Runs once, just before the connection closes; returns its removal. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    this.closed = true
    for (const listener of this.closeListeners) {
      listener()
    }
    this.closeListeners.clear()
    this.db.close()
  }
}

export type OrchestrationDb = OrchestrationDbCore & OrchestrationDbMethods

/** Only the connection: what read queries need, so a reader thread's read-only one runs them too. */
export type OrchestrationDbConnection = Pick<OrchestrationDb, 'db'>

attachOrchestrationDbMethods(OrchestrationDbCore)

// Prototype installation supplies the methods modeled by this construct type.
export const OrchestrationDb = OrchestrationDbCore as new (
  dbPath: (string & {}) | ':memory:'
) => OrchestrationDb
