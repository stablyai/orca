// A chat's Other chats rows: work running in chats it handed work to by mail. Read-only summaries
// per owning chat; Stop, Clear and approvals stay with the chat that started the workers.
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  WORKER_DOCK_UNVERIFIED_READY_MS,
  type WorkerDockElsewhereEntry
} from '../../../../shared/orchestration/dock/worker-dock'
import { readAgentSessionRecordStore } from '../addressing/session-lineage/structured-session-lineage'
import { workerDockSourceSessions } from './worker-dock-source'
import type { WorkerDockActivity } from './worker-dock-activity'
import { readWorkerDockElsewhereActivity } from './worker-dock-elsewhere-activity'
import { WORKER_DOCK_RELATION_WINDOW_MS } from './worker-dock-delegations'

/** The roster's aging rule for a ready worker: with its activity known and not live, it is
 *  unverified, and leaves the list a day after its last change. Shared with the chat's own roster. */
export function workerDockReadyUnverified(
  activity: ReadonlyMap<string, WorkerDockActivity> | undefined,
  live: WorkerDockActivity | undefined
): boolean {
  return (
    activity !== undefined && (!live || live.state === 'unavailable' || live.state === 'unexpected')
  )
}

type Candidate = {
  source: string
  lastAt: number
  dispatchId: string
  state: string
  changedAt: number | null
}

/** Running workers of the chats `source` handed work to that its relations count (before aging). */
function readCandidates(db: OrchestrationDb, source: string): Candidate[] {
  return db.db
    .prepare(
      `SELECT d.target, d.last_at, f.dispatch_id, f.state, f.changed_at
       FROM worker_dock_delegations d
       JOIN worker_dock_facts f INDEXED BY worker_dock_source_state_time
         ON f.source = d.target AND f.state IN ('starting', 'ready', 'stopping')
       JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
       WHERE d.source = ? AND d.target <> d.source
         AND unixepoch(w.created_at) * 1000 <= d.last_at + ${WORKER_DOCK_RELATION_WINDOW_MS}`
    )
    .all(source)
    .map((row) => ({
      source: String(row.target),
      lastAt: Number(row.last_at),
      dispatchId: String(row.dispatch_id),
      state: String(row.state),
      changedAt: typeof row.changed_at === 'number' ? row.changed_at : null
    }))
}

/** Each owning chat's counted ready workers: what phase one refreshes before counting. */
export function workerDockElsewhereReadyCandidates(
  db: OrchestrationDb,
  source: string
): Map<string, string[]> {
  const byOwner = new Map<string, string[]>()
  for (const row of readCandidates(db, source)) {
    if (row.state === 'ready') {
      const ids = byOwner.get(row.source) ?? []
      ids.push(row.dispatchId)
      byOwner.set(row.source, ids)
    }
  }
  return byOwner
}

/** What the rows depend on in the database: relation times and the counted workers' states. A
 *  stream compares it after an unrelated change before re-reading everything. */
export function workerDockElsewhereSignature(db: OrchestrationDb, source: string): string {
  return signatureOf(readCandidates(db, source))
}

function signatureOf(candidates: readonly Candidate[]): string {
  return JSON.stringify(
    candidates
      .map((row) => [row.source, row.lastAt, row.dispatchId, row.state])
      .sort((a, b) => String(a[2]).localeCompare(String(b[2])))
  )
}

export type WorkerDockElsewhereRead = {
  elsewhere: WorkerDockElsewhereEntry[]
  /** A relation young enough that new work can still count: the island keeps watching. */
  relations: boolean
  /** A counted ready worker aged out unverified: its pane stays watched, so a recovery shows. */
  hasUnverifiedElsewhere: boolean
  nextExpiry?: number
  /** Every counted worker (before aging), mapped to its owning chat. */
  counted: { source: string; dispatchId: string }[]
  /** Counted ready workers per owning chat, aged-out ones included: the panes to keep watching. */
  ready: Map<string, string[]>
  /** `workerDockElsewhereSignature` of what this read counted. */
  signature: string
  /** Sessions of the owning chats' lineages: a change to one renames or moves a row. */
  sessions: Set<string>
}

function sessionFacts(source: string): { sessionId: string; title?: string; workspaceId?: string } {
  const sessionId = workerDockSourceSessions(source).at(-1) ?? source
  let record: ReturnType<NonNullable<ReturnType<typeof readAgentSessionRecordStore>>['getRecord']>
  try {
    record = readAgentSessionRecordStore()?.getRecord(sessionId) ?? null
  } catch {
    record = null
  }
  const title = record?.conversationName?.trim()
  const workspaceId = record?.location.workspaceId
  return {
    sessionId,
    ...(title ? { title } : {}),
    ...(workspaceId ? { workspaceId } : {})
  }
}

export function readWorkerDockElsewhere(
  db: OrchestrationDb,
  source: string,
  now = Date.now()
): WorkerDockElsewhereRead {
  const candidates = readCandidates(db, source)
  const newest = db.db
    .prepare('SELECT max(last_at) AS at FROM worker_dock_delegations WHERE source = ?')
    .get(source)
  const newestAt = typeof newest?.at === 'number' ? newest.at : null
  const watchUntil = newestAt === null ? null : newestAt + WORKER_DOCK_RELATION_WINDOW_MS
  const relations = watchUntil !== null && watchUntil > now
  let nextExpiry = relations ? (watchUntil ?? undefined) : undefined
  let hasUnverifiedElsewhere = false
  const ready = new Map<string, string[]>()
  const groups = new Map<string, { lastAt: number; ids: Set<string> }>()
  for (const row of candidates) {
    if (row.state === 'ready') {
      const ids = ready.get(row.source) ?? []
      ids.push(row.dispatchId)
      ready.set(row.source, ids)
      const activity = readWorkerDockElsewhereActivity(db, source, row.source)
      if (workerDockReadyUnverified(activity, activity?.get(row.dispatchId))) {
        const expires = (row.changedAt ?? 0) + WORKER_DOCK_UNVERIFIED_READY_MS
        if (expires <= now) {
          hasUnverifiedElsewhere = true
          continue
        }
        nextExpiry = Math.min(nextExpiry ?? expires, expires)
      }
    }
    const group = groups.get(row.source) ?? { lastAt: row.lastAt, ids: new Set<string>() }
    group.lastAt = Math.max(group.lastAt, row.lastAt)
    group.ids.add(row.dispatchId)
    groups.set(row.source, group)
  }
  const elsewhere = [...groups]
    .sort(([a, left], [b, right]) => right.lastAt - left.lastAt || a.localeCompare(b))
    .map(([owner, group]) => ({ source: owner, running: group.ids.size, ...sessionFacts(owner) }))
  return {
    elsewhere,
    relations,
    hasUnverifiedElsewhere,
    ...(nextExpiry !== undefined ? { nextExpiry } : {}),
    counted: candidates.map((row) => ({ source: row.source, dispatchId: row.dispatchId })),
    ready,
    signature: signatureOf(candidates),
    sessions: new Set(elsewhere.flatMap((row) => workerDockSourceSessions(row.source)))
  }
}
