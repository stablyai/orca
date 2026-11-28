// Handoff mail from one chat to another, kept as the newest mail per pair (both /clear roots), so the
// sender's island can show the work running in the chat it handed work to. Written in the mail's own
// savepoint; a bot handoff from before this existed is backfilled once.
import type { OrchestrationDb } from '../db/orchestration-db'
import { parseOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import { currentRunCoordinatorOrcaSessionId } from '../db/runs/run-coordinator-orca-session'
import { workerSeatGrabSql } from '../db/runs/run-coordinator-mail-routing'
import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'
import { exposeUtcTimestamp } from '../db/utc-timestamp'
import { readAgentSessionRecordStore } from '../addressing/session-lineage/structured-session-lineage'
import { workerDockSourceOfSession } from './worker-dock-source'

/** A worker counts for a handoff when it was created no later than this long after the newest one. */
export const WORKER_DOCK_RELATION_WINDOW_MS = 24 * 60 * 60_000
/** A relation this old goes, unless a worker it counts still runs. */
export const WORKER_DOCK_RELATION_RETENTION_MS = 30 * 24 * 60 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
/** At most this many earlier bot handoffs are backfilled, newest first. */
const BACKFILL_LIMIT = 2000

/** Running workers of a relation's target that the relation counts (rules 1 and 3; aging is JS's). */
export const workerDockRelationWorkersSql = (relation: string) => `
  SELECT f.dispatch_id, f.state, f.changed_at FROM worker_dock_facts f INDEXED BY worker_dock_source_state_time
  JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
  WHERE f.source = ${relation}.target AND f.state IN ('starting', 'ready', 'stopping')
    AND unixepoch(w.created_at) * 1000 <= ${relation}.last_at + ${WORKER_DOCK_RELATION_WINDOW_MS}`

export type WorkerDockDelegationMail = {
  from: string
  to: string
  type?: string
  /** The chat the sender addressed, before routing rewrote `to` to its Run or Dispatch mailbox. */
  addressedSession?: string
  /** False for mail that fans out to a group: it never records a handoff to one chat. */
  delegation?: boolean
}

/** A routed mail's mailbox, with the chat the sender addressed before routing rewrote it. */
export function handoffMailbox(
  recipient: { to: string; runId: string | undefined },
  address: string
): { to: string; runId: string | undefined; addressedSession?: string } {
  const addressedSession = parseOrcaSessionAddress(address)
  return {
    to: recipient.to,
    runId: recipient.runId,
    ...(addressedSession ? { addressedSession } : {})
  }
}

function root(sessionId: string | null | undefined): string | null {
  return sessionId ? workerDockSourceOfSession(sessionId) : null
}

/** The chat a stored recipient names: a session, a Dispatch's assignee, or a local Run's coordinator. */
function storedRecipient(db: OrchestrationDb, to: string): string | null {
  const session = parseOrcaSessionAddress(to)
  if (session) {
    return session
  }
  if (to.startsWith('dispatch:')) {
    const id = to.slice('dispatch:'.length)
    return db.getFederatedDispatch(id)
      ? null
      : (db.getDispatchContextById(id)?.assignee_orca_session_id ?? null)
  }
  if (!to.startsWith('run:')) {
    return null
  }
  const run = db.getRun(to.slice('run:'.length))
  if (!run || run.legacy || run.home_database !== 'this_database') {
    return null
  }
  // Resolved as the mail is stored, so the current coordinator is the one the mail reached.
  const current = currentRunCoordinatorOrcaSessionId(run)
  if (current) {
    return current
  }
  // A terminal now coordinates it: its former chats are not who the mail reached.
  if (run.coordinator_handle !== null || run.coordinator_pane_key !== null) {
    return null
  }
  const aliases = db.db
    .prepare(
      `SELECT rc.terminal_handle FROM run_coordinator_handles rc
       WHERE rc.run_id = ? AND rc.terminal_handle LIKE 'orca_session_id:%' AND NOT ${workerSeatGrabSql('rc')}`
    )
    .all(run.id)
    .flatMap((row) => parseOrcaSessionAddress(String(row.terminal_handle)) ?? [])
  const roots = new Set(aliases.map((alias) => workerDockSourceOfSession(alias)))
  // Several chats once coordinated it: never guess which one the mail meant.
  return roots.size === 1 ? aliases[0]! : null
}

function upsert(
  db: OrchestrationDb,
  source: string,
  target: string,
  at: number,
  messageId: string
): void {
  db.db
    .prepare(
      `INSERT INTO worker_dock_delegations(source, target, last_at, message_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(source, target) DO UPDATE SET last_at = excluded.last_at, message_id = excluded.message_id
       WHERE excluded.last_at >= worker_dock_delegations.last_at`
    )
    .run(source, target, at, messageId)
}

const pruned = new WeakMap<OrchestrationDb, Map<string, number>>()

/** Old relations go, at most hourly per chat, unless a worker they count still runs. */
function prune(db: OrchestrationDb, source: string, now: number): void {
  let bySource = pruned.get(db)
  if (!bySource) {
    bySource = new Map()
    pruned.set(db, bySource)
  }
  if (now - (bySource.get(source) ?? 0) < PRUNE_EVERY_MS) {
    return
  }
  bySource.set(source, now)
  db.db
    .prepare(
      `DELETE FROM worker_dock_delegations WHERE source = ? AND last_at < ?
       AND NOT EXISTS (${workerDockRelationWorkersSql('worker_dock_delegations')})`
    )
    .run(source, now - WORKER_DOCK_RELATION_RETENTION_MS)
}

/** Records a stored handoff mail; returns the sender's root when a relation was written. */
export function recordWorkerDockDelegation(
  db: OrchestrationDb,
  mail: WorkerDockDelegationMail,
  messageId: string,
  now = Date.now()
): string | null {
  if (mail.type !== 'handoff' || mail.delegation === false) {
    return null
  }
  const source = root(parseOrcaSessionAddress(mail.from))
  const target = root(mail.addressedSession ?? storedRecipient(db, mail.to))
  if (!source || !target || source === target) {
    return null
  }
  upsert(db, source, target, now, messageId)
  prune(db, source, now)
  return source
}

const backfilled = new WeakMap<OrchestrationDb, boolean>()

/** Whether the one-time backfill of earlier bot handoff mail has committed. */
export function workerDockDelegationsBackfilled(db: OrchestrationDb): boolean {
  let done = backfilled.get(db)
  if (done === undefined) {
    done = db.db.prepare('SELECT 1 FROM worker_dock_delegations_backfill').get() !== undefined
    if (done) {
      backfilled.set(db, true)
    }
  }
  return done
}

/**
 * Backfills relations from the last 30 days of bot handoff mail, once, as its own committed
 * transaction. Only bot requests: one is always mailed to one chat, so no group fan-out (which stores
 * ordinary mail with no group marker) can come back as a handoff. A Run-addressed mail is skipped:
 * who coordinated that Run then is not recorded. Returns the chats whose islands should look again,
 * or null when it did not run (already done, lineage not loaded yet, or inside a transaction).
 */
export function backfillWorkerDockDelegations(
  db: OrchestrationDb,
  now = Date.now()
): string[] | null {
  if (
    workerDockDelegationsBackfilled(db) ||
    db.db.isTransaction ||
    readAgentSessionRecordStore() === null
  ) {
    return null
  }
  const sources = new Set<string>()
  runLifecycleWriteTransaction(db.db, 'worker_dock_delegations_backfill', () => {
    // Bounded by its index: only the last 30 days of bot handoffs are visited, newest first, capped.
    db.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_bot_requests_purpose_created ON bot_requests(purpose, created_at)'
    )
    const rows = db.db
      .prepare(
        `SELECT m.id, m.from_handle, m.to_handle, m.created_at
         FROM bot_requests r INDEXED BY idx_bot_requests_purpose_created
         JOIN messages m ON m.id = r.message_id
         WHERE r.purpose = 'handoff' AND r.created_at > datetime(?, 'unixepoch', '-30 days')
           AND m.type = 'handoff'
         ORDER BY r.created_at DESC LIMIT ${BACKFILL_LIMIT}`
      )
      .all(Math.floor(now / 1000))
    for (const row of rows) {
      const to = String(row.to_handle)
      if (to.startsWith('run:')) {
        continue
      }
      const source = root(parseOrcaSessionAddress(String(row.from_handle)))
      const target = root(storedRecipient(db, to))
      const at = Date.parse(exposeUtcTimestamp(String(row.created_at)) ?? '')
      if (source && target && source !== target && Number.isFinite(at)) {
        upsert(db, source, target, at, String(row.id))
        sources.add(source)
      }
    }
    db.db.prepare('INSERT OR IGNORE INTO worker_dock_delegations_backfill(id) VALUES (1)').run()
  })
  backfilled.set(db, true)
  // Every chat with a young relation, or a counted worker (before aging), looks again: one query.
  return db.db
    .prepare(
      `SELECT DISTINCT d.source FROM json_each(?) chats
       JOIN worker_dock_delegations d ON d.source = chats.value
       WHERE d.last_at > ? OR EXISTS (${workerDockRelationWorkersSql('d')})`
    )
    .all(JSON.stringify([...sources]), now - WORKER_DOCK_RELATION_WINDOW_MS)
    .map((row) => String(row.source))
}
