import {
  isUserKeptWorkerTerminal,
  USER_KEPT_WORKER_TERMINAL_SQL,
  WORKER_SETTLED_STATES,
  type WorkerTerminalResourceRow
} from '../../worker-terminal-ownership'
import {
  isEquivalentPaneKey,
  paneKeyMatchSuffix,
  WORKER_TERMINAL_PANE_KEY_MATCH_SUFFIX_SQL
} from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerAutoCloseState } from '../../../../../shared/worker-auto-close'
import { exposeUtcTimestamp, toSqliteUtcTimestamp } from '../utc-timestamp'
import { OrchestrationError } from '../../orchestration-error'
import { retainTerminalResourceInTransaction } from './worker-terminal-archive'
import {
  OWNER_RELEASABLE_SQL,
  WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS
} from './worker-terminal-auto-release'

type PaneResource = { id: string; owner_dispatch_id: string; pane_key: string }

// Exact pane key first; a reminted tab id still names the same leaf.
function findResources(db: OrchestrationDb, paneKey: string, matchSql: string): PaneResource[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the three columns the row type names.
  const exact = db.db
    .prepare(
      `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
        WHERE pane_key = ? AND ${matchSql} ORDER BY updated_at DESC`
    )
    .all(paneKey) as PaneResource[]
  if (exact.length > 0) {
    return exact
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the three columns the row type names.
  const candidates = db.db
    .prepare(
      `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
        WHERE ${matchSql} AND ${WORKER_TERMINAL_PANE_KEY_MATCH_SUFFIX_SQL} = ?
        ORDER BY updated_at DESC`
    )
    .all(paneKeyMatchSuffix(paneKey)) as PaneResource[]
  return candidates.filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
}

// Keep open wins at any stage up to its automatic close's admission; explicit releases pass.
const KEEPABLE_RESOURCE_SQL = `ownership_state = 'owned' AND (release_state = 'not_requested'
  OR (release_state IN ('requested', 'releasing') AND auto_release_at IS NOT NULL
      AND auto_release_dispatch_id = owner_dispatch_id))`

const KEPT_RESOURCE_SQL = `ownership_state = 'owned' AND ${USER_KEPT_WORKER_TERMINAL_SQL}`

/** Keep open: neither Orca nor the coordinator closes or reuses the worker until the user allows auto-close. */
export function keepWorkerTerminalOpen(this: OrchestrationDb, paneKey: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    let changed = 0
    for (const candidate of findResources(this, paneKey, KEEPABLE_RESOURCE_SQL)) {
      if (
        retainTerminalResourceInTransaction(
          this,
          candidate.id,
          candidate.owner_dispatch_id,
          KEEPABLE_RESOURCE_SQL,
          'user_kept'
        )
      ) {
        changed += 1
      }
    }
    this.db.exec('COMMIT')
    if (changed > 0) {
      this.workerTerminalAutoReleaseListener?.()
    }
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Undoes Keep open; a finished worker gets a fresh countdown from `restAt`, held (null) while its agent works. */
export function allowWorkerTerminalAutoClose(
  this: OrchestrationDb,
  paneKey: string,
  restAt: (resource: WorkerTerminalResourceRow) => number | null
): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const update = this.db.prepare(
      `UPDATE worker_terminal_resources
          SET release_state = 'not_requested', retained_reason = NULL,
              auto_release_dispatch_id = CASE WHEN ${OWNER_RELEASABLE_SQL}
                THEN owner_dispatch_id ELSE auto_release_dispatch_id END,
              auto_release_at = CASE WHEN ${OWNER_RELEASABLE_SQL} THEN ? END,
              updated_at = datetime('now')
        WHERE id = ? AND ${KEPT_RESOURCE_SQL}`
    )
    let changed = 0
    for (const candidate of findResources(this, paneKey, KEPT_RESOURCE_SQL)) {
      const resource = this.getWorkerTerminalResource(candidate.id)
      const restMs = resource ? restAt(resource) : null
      const deadline =
        restMs === null
          ? null
          : toSqliteUtcTimestamp(restMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS)
      changed += Number(update.run(deadline, candidate.id).changes)
    }
    this.db.exec('COMMIT')
    if (changed > 0) {
      this.workerTerminalAutoReleaseListener?.()
    }
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Called before a stop changes anything: a refused stop must leave the worker and its authority as they were. */
export function refuseStopWhileKeptOpen(db: OrchestrationDb, dispatchId: string): void {
  if (isUserKeptWorkerTerminalOwner(db, dispatchId)) {
    throw keptOpenStopRefusal(dispatchId)
  }
}

export function isUserKeptWorkerTerminalOwner(db: OrchestrationDb, dispatchId: string): boolean {
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  return resource?.ownership_state === 'owned' && isUserKeptWorkerTerminal(resource)
}

export function keptOpenStopRefusal(dispatchId: string): OrchestrationError {
  return new OrchestrationError(
    'terminal_kept_open',
    `The user chose Keep open for Dispatch ${dispatchId}, so it was not stopped. Only the user can undo that, with Allow Auto-Close on its tab; then run worker-stop again.`
  )
}

export function getWorkerAutoCloseState(
  this: OrchestrationDb,
  paneKey: string
): WorkerAutoCloseState | null {
  if (this.workerAutoReleaseEnabled?.() === false) {
    return null
  }
  const [candidate] = findResources(
    this,
    paneKey,
    "ownership_state = 'owned' AND release_state != 'released'"
  )
  const resource = candidate ? this.getWorkerTerminalResource(candidate.id) : undefined
  if (!resource) {
    return null
  }
  if (resource.release_state === 'retained') {
    return resource.retained_reason === 'user_kept' ? { kept: true } : null
  }
  const ownerState =
    this.getWorkerDispatch(resource.owner_dispatch_id)?.state ??
    this.getRemoteDispatchAttachment(resource.owner_dispatch_id)?.state
  if (resource.release_state === 'not_requested' && ownerState) {
    if (!WORKER_SETTLED_STATES.includes(ownerState)) {
      return { kept: false, closesAt: null }
    }
    if (resource.auto_release_dispatch_id === resource.owner_dispatch_id) {
      return { kept: false, closesAt: exposeUtcTimestamp(resource.auto_release_at) }
    }
  }
  return closingAutomatically(resource)
    ? { kept: false, closesAt: exposeUtcTimestamp(resource.auto_release_at) }
    : null
}

function closingAutomatically(resource: WorkerTerminalResourceRow): boolean {
  return (
    (resource.release_state === 'requested' || resource.release_state === 'releasing') &&
    resource.auto_release_at !== null &&
    resource.auto_release_dispatch_id === resource.owner_dispatch_id
  )
}
