import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../db/orchestration-db'
import { workerDockSession } from './worker-dock-read'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { createSessionWorkerLivenessReader } from '../workers/lifecycle/session-worker-liveness'
import { mintFleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { WorkerDockEntry } from '../../../../shared/orchestration/dock/worker-dock'

type WorkerDockActivity = {
  episode: string
  state: WorkerDockEntry['state']
  changedAt: number
}
type WorkerDockActivityStore = {
  revision: number
  bySource: Map<string, Map<string, WorkerDockActivity>>
}

// Agent status already lives in memory, so the running/idle look it derives does too: no DB write per status change.
const stores = new WeakMap<OrchestrationDb, WorkerDockActivityStore>()

function activityStore(db: OrchestrationDb): WorkerDockActivityStore {
  let store = stores.get(db)
  if (!store) {
    store = { revision: 0, bySource: new Map() }
    stores.set(db, store)
  }
  return store
}

/** The source's ready workers' activity by dispatch, as last derived from agent status. */
export function readWorkerDockActivity(
  db: OrchestrationDb,
  source: string
): ReadonlyMap<string, WorkerDockActivity> | undefined {
  return stores.get(db)?.bySource.get(source)
}

/** Rises with every activity change; added to the snapshot revision so readers see it move. */
export function workerDockActivityRevision(db: OrchestrationDb): number {
  return stores.get(db)?.revision ?? 0
}

/** The host normalizes each represented status episode once; replay and heartbeats keep its time. */
export function refreshWorkerDockActivity(
  db: OrchestrationDb,
  party: string,
  runtime: Pick<
    OrcaRuntimeService,
    | 'getAgentStatusSnapshotFn'
    | 'readObservedAgentStatusPaneIdentityFn'
    | 'getAgentStatusTerminalHandleForPaneKey'
    | 'getTerminalProcessIncarnation'
  >,
  panes?: Set<string>
): number | null {
  const source = workerDockSession(party)
  const now = Date.now()
  let expiresAt: number | null = null
  const candidates = db.db
    .prepare(
      `SELECT d.id, d.assignee_pane_key, d.assignee_handle, d.process_incarnation
    FROM worker_dock_facts f INDEXED BY worker_dock_source_state
    JOIN dispatch_contexts d ON d.id = f.dispatch_id WHERE f.source = ? AND f.state = 'ready'`
    )
    .all(source)
  panes?.clear()
  for (const row of candidates) {
    if (typeof row.assignee_pane_key === 'string') {
      panes?.add(row.assignee_pane_key)
    }
  }
  if (!candidates.length) {
    stores.get(db)?.bySource.delete(source)
    return null
  }
  const statuses = runtime.getAgentStatusSnapshotFn?.() ?? []
  const byPane = new Map(statuses.map((status) => [status.paneKey, status]))
  const sessionFor = createSessionWorkerLivenessReader(
    db,
    statuses.map((status) =>
      mintFleetAgentStatusEvidence(status, {
        kind: 'unresolved',
        reason: 'pane_not_bound'
      })
    )
  )
  const store = activityStore(db)
  const previous = store.bySource.get(source)
  // Only the source's ready workers are kept, so a settled or deleted worker's entry goes with it.
  const next = new Map<string, WorkerDockActivity>()
  let changed = previous !== undefined && previous.size !== candidates.length
  for (const row of candidates) {
    const session = sessionFor({
      agentTerminalHandle: typeof row.assignee_handle === 'string' ? row.assignee_handle : null,
      resource: {
        processIncarnation:
          typeof row.process_incarnation === 'string' ? row.process_incarnation : null
      }
    })
    const pane =
      session?.status === 'live' && session.activity
        ? session.activity.activity.paneKey
        : typeof row.assignee_pane_key === 'string'
          ? row.assignee_pane_key
          : null
    const observed = pane ? runtime.readObservedAgentStatusPaneIdentityFn(pane) : null
    const status = pane ? byPane.get(pane) : undefined
    const bound =
      observed?.kind === 'observed' &&
      observed.dispatchId === row.id &&
      observed.terminalHandle === row.assignee_handle &&
      runtime.getAgentStatusTerminalHandleForPaneKey(pane!) === observed.terminalHandle &&
      runtime.getTerminalProcessIncarnation(observed.terminalHandle) ===
        observed.processIncarnation &&
      (!row.process_incarnation || row.process_incarnation === observed.processIncarnation)
    const fresh =
      (session ? session.status === 'live' : bound) &&
      status &&
      !status.restoredUnconfirmed &&
      !status.providerSessionOnly &&
      isAgentStatusFresh(
        {
          ...status,
          updatedAt: status.receivedAt,
          structuredHostOwned: status.structuredHost === 'owned' ? true : undefined
        },
        now
      )
    if (fresh && status.structuredHost !== 'owned') {
      const deadline =
        (status.evidenceObservedAt ?? status.receivedAt) + AGENT_STATUS_STALE_AFTER_MS
      if (deadline > now) {
        expiresAt = Math.min(expiresAt ?? deadline, deadline)
      }
    }
    const state = !fresh
      ? 'unavailable'
      : status.state === 'working'
        ? 'running'
        : status.state === 'done'
          ? 'idle'
          : 'coordinator'
    const episode = fresh
      ? JSON.stringify([row.process_incarnation, status.stateStartedAt, state])
      : 'unavailable'
    const kept = previous?.get(row.id)
    if (kept?.episode === episode) {
      next.set(row.id, kept)
    } else {
      next.set(row.id, { episode, state, changedAt: now })
      changed = true
    }
  }
  store.bySource.set(source, next)
  if (changed) {
    store.revision += 1
    db.workerDockSources.invalidate(source, false)
  }
  return expiresAt
}
