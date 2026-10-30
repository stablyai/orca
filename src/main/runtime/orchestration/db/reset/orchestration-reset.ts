import { LEGACY_RUN_ID } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'
import type { ResetRemovedWork } from '../../../../../shared/orchestration-removed-work'
import {
  readRemovedWorkWatermark,
  summarizeRemovedWorkSince
} from './removed-orchestration-work-read'

/** Returns the removed-work watermark, read inside the transaction so the reply counts only this reset. */
export function runResetTransaction(this: OrchestrationDb, statements: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    // Why unguarded: an error that ends the transaction must roll the whole reset back, not let the deletes autocommit.
    const watermark = readRemovedWorkWatermark(this.db)
    this.db.exec(statements)
    this.db.exec('COMMIT')
    return watermark
  } catch (error) {
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // A failed commit may already roll back; preserve the original error if rollback also fails.
    }
    throw error
  }
}

export function resetAll(this: OrchestrationDb): void {
  // Keep receipts so a lost reset reply cannot replay the mutation.
  this.runResetTransaction(`
    DELETE FROM coordinator_runs;
    DELETE FROM decision_gates;
    DELETE FROM remote_questions;
    DELETE FROM question_threads;
    DELETE FROM deliveries;
    DELETE FROM legacy_mail_receipts;
    DELETE FROM legacy_operation_receipts;
    DELETE FROM legacy_compatibility_principals;
    DELETE FROM legacy_adoptions;
    DELETE FROM federation_relay_items;
    DELETE FROM remote_dispatch_attachments;
    DELETE FROM federated_dispatches;
    DELETE FROM worker_terminal_archives;
    DELETE FROM worker_terminal_resources;
    DELETE FROM attempt_observation_facts;
    DELETE FROM structured_pointer_operations;
    DELETE FROM worker_dispatches;
    DELETE FROM dispatch_contexts;
    DELETE FROM tasks;
    DELETE FROM messages;
    DELETE FROM run_coordinator_handles;
    DELETE FROM runs;
    DELETE FROM removed_orchestration_work;
    INSERT INTO runs (id, objective, home_database, consumer_generation, legacy)
      VALUES ('${LEGACY_RUN_ID}', 'Legacy orchestration state (inspect only)', 'this_database', 0, 1);
  `)
  this.hasAnyDispatchContextsCache = undefined
}

export function resetTasks(this: OrchestrationDb): ResetRemovedWork | undefined {
  // Messages survive; close threads so orphaned questions cannot masquerade as generic replies.
  const watermark = this.runResetTransaction(`
    DELETE FROM coordinator_runs;
    DELETE FROM decision_gates;
    DELETE FROM remote_questions;
    UPDATE question_threads
      SET status = 'closed', closed_at = COALESCE(closed_at, datetime('now'))
      WHERE status = 'pending';
    DELETE FROM legacy_mail_receipts;
    DELETE FROM legacy_operation_receipts;
    DELETE FROM legacy_compatibility_principals;
    DELETE FROM legacy_adoptions;
    DELETE FROM federation_relay_items;
    DELETE FROM remote_dispatch_attachments;
    DELETE FROM federated_dispatches;
    DELETE FROM worker_terminal_archives;
    DELETE FROM worker_terminal_resources;
    DELETE FROM attempt_observation_facts;
    DELETE FROM structured_pointer_operations;
    DELETE FROM worker_dispatches;
    DELETE FROM dispatch_contexts;
    DELETE FROM tasks;
  `)
  this.hasAnyDispatchContextsCache = undefined
  return summarizeRemovedWorkSince(this.db, watermark)
}

export function resetMessages(this: OrchestrationDb): void {
  // Keep relay rows for contiguous cross-server cursors; drop pointer operations whose deleted message batch no longer exists.
  this.runResetTransaction(`
    DELETE FROM legacy_mail_receipts;
    DELETE FROM question_threads;
    DELETE FROM deliveries;
    DELETE FROM messages;
    DELETE FROM structured_pointer_operations;
  `)
}

export type OrchestrationResetMethods = {
  runResetTransaction: typeof runResetTransaction
  resetAll: typeof resetAll
  resetTasks: typeof resetTasks
  resetMessages: typeof resetMessages
}

export function attachOrchestrationReset(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    runResetTransaction,
    resetAll,
    resetTasks,
    resetMessages
  })
}
