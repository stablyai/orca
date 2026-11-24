import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { readRemovedWorkWatermark } from '../reset/removed-orchestration-work-read'
import { forgetUnownedRemovedWork, RETENTION_AGE, RETIRED_RUN_SQL } from './settled-run-retention'
import {
  forgetRetiringRunWrites,
  isRetiringRunMailbox,
  isRetiringRunWritten,
  unwatchRetiringRun,
  watchRetiringRun
} from './run-retirement-write-watch'

const DISPATCH_IDS = 'SELECT id FROM dispatch_contexts WHERE run_id = ?1'
const MESSAGE_IDS = 'SELECT id FROM messages WHERE run_id = ?1'
const LEGACY_PRINCIPAL_IDS = 'SELECT id FROM legacy_compatibility_principals WHERE run_id = ?1'

// Dispatch-keyed rows go first, while each Dispatch still names its Run for removed-work capture.
// Each is deleted a page at a time and the Run row goes last, so the next pass finishes an interrupted one.
const RUN_CHILD_DELETES: readonly { table: string; where: string; pageRows?: number }[] = [
  // Saved output copies run to 256 KB each.
  { table: 'worker_terminal_archives', where: `dispatch_id IN (${DISPATCH_IDS})`, pageRows: 8 },
  { table: 'federation_relay_items', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'federation_relay_sequences', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'remote_questions', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'remote_dispatch_attachments', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'attempt_observation_facts', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'federated_dispatches', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'worker_terminal_resources', where: `owner_dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'worker_dispatches', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'worker_presence', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'message_dispatch_provenance', where: `dispatch_id IN (${DISPATCH_IDS})` },
  { table: 'message_dispatch_provenance', where: `message_id IN (${MESSAGE_IDS})` },
  { table: 'structured_mail_sends', where: `message_id IN (${MESSAGE_IDS})` },
  { table: 'legacy_operation_receipts', where: `principal_id IN (${LEGACY_PRINCIPAL_IDS})` },
  { table: 'legacy_mail_receipts', where: `principal_id IN (${LEGACY_PRINCIPAL_IDS})` },
  { table: 'legacy_compatibility_principals', where: 'run_id = ?1' },
  { table: 'question_threads', where: 'run_id = ?1' },
  { table: 'decision_gates', where: 'run_id = ?1' },
  { table: 'deliveries', where: 'run_id = ?1' },
  { table: 'dispatch_contexts', where: 'run_id = ?1' },
  // Each message row updates about 17 indexes.
  { table: 'messages', where: 'run_id = ?1', pageRows: 64 },
  { table: 'tasks', where: 'run_id = ?1' },
  { table: 'structured_pointer_operations', where: "mailbox_handle = 'run:' || ?1" },
  // The deletes above record each Task, Dispatch and worker row; the Run's own delete would drop all.
  { table: 'removed_orchestration_work', where: 'run_id = ?1' }
]

/** Rows one retention step deletes from one table, small enough to keep each step short. */
const RUN_CHILD_PAGE_ROWS = 128

const RUN_CHILD_PAGES = RUN_CHILD_DELETES.map(({ table, where, pageRows }) => ({
  rows: pageRows ?? RUN_CHILD_PAGE_ROWS,
  sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?2)`
}))

const RUN_DELETES = [
  ...RUN_CHILD_DELETES.map(({ table, where }) => `DELETE FROM ${table} WHERE ${where}`),
  // Its triggers drop the Run's coordinator handles and removed-work records.
  'DELETE FROM runs WHERE id = ?1'
]

export type RunPartyLiveness = {
  isLiveHandle(handle: string): boolean
  isLivePane(paneKey: string): boolean
  /** Mailboxes a reader is blocked on, in memory, so every page can ask; there are few at a time. */
  waitedMailboxes(): Iterable<string>
}

// A re-minted terminal keeps its pane, so every pane the Run's coordinators used counts too.
// A worker terminal still open, such as one handed to the user, keeps its Run as well.
const RUN_PARTIES_EXCEPT_SENDER_PANES = `SELECT 'handle' AS kind, 'run:' || ?1 AS party
  UNION SELECT 'handle', coordinator_handle FROM runs WHERE id = ?1
  UNION SELECT 'handle', terminal_handle FROM run_coordinator_handles WHERE run_id = ?1
  UNION SELECT 'handle', to_handle FROM messages
    WHERE run_id = ?1 AND read = 0 AND delivery_contract = 'current_delivery'
  UNION SELECT 'pane', coordinator_pane_key FROM runs WHERE id = ?1
  UNION SELECT 'pane', creator_pane_key FROM dispatch_contexts WHERE run_id = ?1
  UNION SELECT 'pane', created_by_pane_key FROM tasks WHERE run_id = ?1
  UNION SELECT 'handle', terminal_handle FROM worker_terminal_resources
    WHERE owner_dispatch_id IN (${DISPATCH_IDS})
  UNION SELECT 'pane', pane_key FROM worker_terminal_resources
    WHERE owner_dispatch_id IN (${DISPATCH_IDS})`
const COORDINATOR_SENDER_PANES = `SELECT sender_pane_key FROM messages
  WHERE run_id = ?1 AND from_handle IN (
    SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?1)`
// Reading every message of a Run with thousands of them takes over 100 ms, so the first read pages.
const SENDER_PANE_PAGE = `SELECT sequence, sender_pane_key,
    from_handle IN (SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?1) AS coordinator
  FROM messages WHERE run_id = ?1 AND sequence > ?2 ORDER BY sequence LIMIT ?3`
const SENDER_PANES_PER_STEP = 256

function partyKeys(rows: Record<string, unknown>[]): string[] {
  return rows.flatMap((row) =>
    row.party === null ? [] : [`${String(row.kind)}:${String(row.party)}`]
  )
}

function runParties({ db }: OrchestrationDb, runId: string): string[] {
  return partyKeys(
    db
      .prepare(
        `${RUN_PARTIES_EXCEPT_SENDER_PANES}
         UNION SELECT 'pane', sender_pane_key FROM (${COORDINATOR_SENDER_PANES})`
      )
      .all(runId)
  )
}

function isLiveRunParty(party: string, liveness: RunPartyLiveness): boolean {
  return party.startsWith('pane:')
    ? liveness.isLivePane(party.slice('pane:'.length))
    : liveness.isLiveHandle(party.slice('handle:'.length))
}

function isRetiredRun(db: OrchestrationDb['db'], runId: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM runs r WHERE r.id = ?2 AND ${RETIRED_RUN_SQL}`)
      .get(RETENTION_AGE, runId)
  )
}

/**
 * Deletes one settled Run in bounded steps, one per `next()`, each its own transaction: its parties
 * are read a page at a time, then its rows a page of one table at a time, then the Run row. It keeps
 * the Run when a coordinator it bound, a reader of its unread mail or its worker terminal is live,
 * read first and again before the Run row (panes and blocked readers, read in memory, on every page),
 * or once anything writes to the Run: fully checked first and before the Run row, and before every
 * page by the write watch, which sees a write in place as well as a new row. A step interrupted by a
 * quit or crash leaves only fewer settled rows.
 */
export function* retireSettledRun(
  orchestrationDb: OrchestrationDb,
  runId: string,
  liveness: RunPartyLiveness
): Generator<void, boolean> {
  const { db } = orchestrationDb
  if (!isRetiredRun(db, runId)) {
    return false
  }
  watchRetiringRun(orchestrationDb, runId)
  try {
    const parties = new Set(partyKeys(db.prepare(RUN_PARTIES_EXCEPT_SENDER_PANES).all(runId)))
    for (let after = 0; ;) {
      yield
      const page = db.prepare(SENDER_PANE_PAGE).all(runId, after, SENDER_PANES_PER_STEP)
      for (const row of page) {
        if (row.coordinator && row.sender_pane_key !== null) {
          parties.add(`pane:${String(row.sender_pane_key)}`)
        }
      }
      if (page.length < SENDER_PANES_PER_STEP) {
        break
      }
      after = Number(page.at(-1)!.sequence)
    }
    const checkedParties = [...parties]
    const anyPartyLive = (): boolean =>
      checkedParties.some((party) => isLiveRunParty(party, liveness))
    // A handle's liveness reads the database; a pane's is a lookup, and a re-minted terminal keeps its
    // pane. A reader that started mid-way on the Run's or a Dispatch's mailbox, such as a pane-less
    // wait, is found among the few waiting.
    const panes = checkedParties.filter((party) => party.startsWith('pane:'))
    const anyPartySeenLive = (): boolean =>
      panes.some((party) => isLiveRunParty(party, liveness)) ||
      [...liveness.waitedMailboxes()].some(
        (handle) => parties.has(`handle:${handle}`) || isRetiringRunMailbox(orchestrationDb, handle)
      )
    if (anyPartyLive()) {
      return false
    }
    for (let next = 0; next < RUN_CHILD_PAGES.length;) {
      yield
      const from = next
      const step = runLifecycleWriteTransaction(db, 'orchestration_run_retention', () => {
        if (anyPartySeenLive() || isRetiringRunWritten(orchestrationDb)) {
          return undefined
        }
        const watermark = readRemovedWorkWatermark(db)
        // Tables with nothing left cost one indexed lookup, so a step moves on until one deletes.
        let index = from
        for (; index < RUN_CHILD_PAGES.length; index++) {
          const page = RUN_CHILD_PAGES[index]!
          const deleted = db.prepare(page.sql).run(runId, page.rows).changes
          if (deleted > 0) {
            index = deleted < page.rows ? index + 1 : index
            break
          }
        }
        // A deleted row whose Run is gone, such as a remote attachment, leaves a record nothing reads.
        forgetUnownedRemovedWork(orchestrationDb, watermark)
        forgetRetiringRunWrites(orchestrationDb)
        return { next: index }
      })
      if (!step) {
        return false
      }
      orchestrationDb.hasAnyDispatchContextsCache = undefined
      next = step.next
    }
    yield
    const deleted = runLifecycleWriteTransaction(db, 'orchestration_run_retention', () => {
      // Liveness was read before the lock; a party added since keeps the Run.
      if (
        anyPartyLive() ||
        anyPartySeenLive() ||
        isRetiringRunWritten(orchestrationDb) ||
        !isRetiredRun(db, runId) ||
        runParties(orchestrationDb, runId).some((party) => !parties.has(party))
      ) {
        return false
      }
      const watermark = readRemovedWorkWatermark(db)
      for (const statement of RUN_DELETES) {
        db.prepare(statement).run(runId)
      }
      forgetUnownedRemovedWork(orchestrationDb, watermark)
      return true
    })
    if (deleted) {
      orchestrationDb.hasAnyDispatchContextsCache = undefined
    }
    return deleted
  } finally {
    unwatchRetiringRun(orchestrationDb)
  }
}

/** Deletes one settled Run in a single call; maintenance steps `retireSettledRun` instead. */
export function deleteRetiredRun(
  orchestrationDb: OrchestrationDb,
  runId: string,
  liveness: RunPartyLiveness
): boolean {
  const steps = retireSettledRun(orchestrationDb, runId, liveness)
  for (;;) {
    const step = steps.next()
    if (step.done) {
      return step.value
    }
  }
}
