// Other chats' candidate workers' activity, refreshed by the chats whose Other chats rows count them
// and kept apart from those chats' own activity, so their own islands and versions are untouched.
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  activityStore,
  collectAssigneePanes,
  deriveActivity,
  paneSignature,
  paneStatuses,
  type ActivityRuntime,
  type WorkerDockActivity
} from './worker-dock-activity'

/** Another chat's (`owner`) ready workers as `reader`'s Other chats rows see them: only the workers
 *  they count, kept apart from the owner's own activity so its island and version are untouched. */
export function readWorkerDockElsewhereActivity(
  db: OrchestrationDb,
  reader: string,
  owner: string
): ReadonlyMap<string, WorkerDockActivity> | undefined {
  return activityStore(db).elsewhere.get(reader)?.get(owner)
}

/** Refreshes the activity of each owner's counted ready workers for `reader`, dropping owners it no
 *  longer counts; returns the earliest time a fresh status goes stale. Never invalidates an owner:
 *  only the reader that asked reads again. */
export function refreshWorkerDockElsewhereActivity(
  db: OrchestrationDb,
  reader: string,
  candidates: ReadonlyMap<string, readonly string[]>,
  runtime: ActivityRuntime,
  panes?: Set<string>
): number | null {
  const store = activityStore(db)
  const previous = store.elsewhere.get(reader)
  const next = new Map<string, Map<string, WorkerDockActivity>>()
  let expiresAt: number | null = null
  let changed = previous !== undefined && previous.size !== candidates.size
  panes?.clear()
  for (const [owner, dispatchIds] of candidates) {
    const rows = dispatchIds.length
      ? db.db
          .prepare(
            `SELECT d.id, d.assignee_pane_key, d.assignee_handle, d.process_incarnation
          FROM json_each(?) selected CROSS JOIN worker_dock_facts f ON f.dispatch_id = selected.value
          JOIN dispatch_contexts d ON d.id = f.dispatch_id WHERE f.source = ? AND f.state = 'ready'`
          )
          .all(JSON.stringify(dispatchIds), owner)
      : []
    if (!rows.length) {
      changed ||= previous?.has(owner) === true
      continue
    }
    const ownerPanes = new Set<string>()
    collectAssigneePanes(rows, ownerPanes)
    const derived = deriveActivity(db, runtime, rows, previous?.get(owner), ownerPanes, Date.now())
    for (const pane of ownerPanes) {
      panes?.add(pane)
    }
    next.set(owner, derived.next)
    changed ||= derived.changed
    if (derived.expiresAt !== null) {
      expiresAt = Math.min(expiresAt ?? derived.expiresAt, derived.expiresAt)
    }
  }
  if (next.size) {
    store.elsewhere.set(reader, next)
  } else {
    store.elsewhere.delete(reader)
  }
  if (changed) {
    store.revision += 1
  }
  return expiresAt
}

export type WorkerDockElsewhereActivitySource = {
  /** Refreshes each owner's candidate ready workers; returns the earliest stale deadline. */
  refresh: (candidates: ReadonlyMap<string, readonly string[]>) => number | null
  subscribe: (wake: () => void) => () => void
}

/** One open stream's watch on the panes of other chats' candidate workers: a death, exit or recovery
 *  wakes that stream directly, whether or not the owning chat's own island is open. */
export function workerDockElsewhereActivitySource(
  db: OrchestrationDb,
  reader: string,
  runtime: ActivityRuntime & Pick<OrcaRuntimeService, 'subscribeAgentStatusRowChanges'>
): WorkerDockElsewhereActivitySource {
  const panes = new Set<string>()
  const seen = new Map<string, string>()
  const signature = (pane: string) => paneSignature(paneStatuses(runtime, pane), Date.now())
  return {
    refresh: (candidates) => {
      const expiresAt = refreshWorkerDockElsewhereActivity(db, reader, candidates, runtime, panes)
      for (const pane of seen.keys()) {
        if (!panes.has(pane)) {
          seen.delete(pane)
        }
      }
      for (const pane of panes) {
        seen.set(pane, signature(pane))
      }
      return expiresAt
    },
    subscribe: (wake) =>
      runtime.subscribeAgentStatusRowChanges((pane) => {
        if (!panes.has(pane)) {
          return
        }
        const next = signature(pane)
        if (seen.get(pane) === next) {
          return
        }
        seen.set(pane, next)
        wake()
      })
  }
}
