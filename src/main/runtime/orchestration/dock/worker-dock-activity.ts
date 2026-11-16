import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../db/orchestration-db'
import { workerDockSession } from './worker-dock-read'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { createSessionWorkerLivenessReader } from '../workers/lifecycle/session-worker-liveness'
import { mintFleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'

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
    .prepare(`SELECT d.id, d.assignee_pane_key, d.assignee_handle, d.process_incarnation
    FROM worker_dock_facts f INDEXED BY worker_dock_source_state
    JOIN dispatch_contexts d ON d.id = f.dispatch_id WHERE f.source = ? AND f.state = 'ready'`)
    .all(source)
  panes?.clear()
  for (const row of candidates) {
    if (typeof row.assignee_pane_key === 'string') {
      panes?.add(row.assignee_pane_key)
    }
  }
  if (!candidates.length) {
    return null
  }
  const statuses = runtime.getAgentStatusSnapshotFn?.() ?? []
  const byPane = new Map(statuses.map((status) => [status.paneKey, status]))
  const sessionFor = createSessionWorkerLivenessReader(
    db,
    statuses.map((status) =>
      mintFleetAgentStatusEvidence(status, { kind: 'unresolved', reason: 'pane_not_bound' })
    )
  )
  const upsert = db.db
    .prepare(`INSERT INTO worker_dock_activity(dispatch_id, episode, state, changed_at)
    VALUES(?, ?, ?, ?) ON CONFLICT(dispatch_id) DO UPDATE SET episode = excluded.episode,
    state = excluded.state, changed_at = excluded.changed_at WHERE worker_dock_activity.episode <> excluded.episode`)
  runLifecycleWriteTransaction(db.db, 'worker_dock_activity', () => {
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
      if (upsert.run(row.id, episode, state, now).changes) {
        db.workerDockSources.invalidate(source, false)
      }
    }
  })
  return expiresAt
}
