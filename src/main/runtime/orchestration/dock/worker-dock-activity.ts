import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../db/orchestration-db'
import { workerDockSession } from './worker-dock-source'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import {
  createSessionWorkerLivenessReader,
  structuredWorkerSessionIdOf
} from '../workers/lifecycle/session-worker-liveness'
import { chatAssigneeSessionId } from '../workers/lifecycle/chat-assignee'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { mintFleetAgentStatusEvidence } from '../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { WorkerDockEntry } from '../../../../shared/orchestration/dock/worker-dock'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

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

type ActivityRuntime = Pick<
  OrcaRuntimeService,
  | 'readAgentStatusOfPanes'
  | 'readObservedAgentStatusPaneIdentityFn'
  | 'getAgentStatusTerminalHandleForPaneKey'
  | 'getTerminalProcessIncarnation'
>

function statusFresh(status: AgentStatusIpcPayload, now: number): boolean {
  return (
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
  )
}

function paneStatuses(runtime: ActivityRuntime, pane: string): AgentStatusIpcPayload[] {
  return runtime.readAgentStatusOfPanes([pane]).filter((row) => row.paneKey === pane)
}

/** What one pane's status adds to the dock's look; a heartbeat leaves it the same. */
function paneSignature(rows: readonly AgentStatusIpcPayload[], now: number): string {
  return JSON.stringify(
    rows.map((row) => [row.state, row.stateStartedAt, row.structuredHost, statusFresh(row, now)])
  )
}

/** One dock subscription's activity: it wakes only when a ready worker's pane changes what the dock
 *  shows, so heartbeats and prompt edits cost one pane read, never a SELECT or an every-pane snapshot. */
export function workerDockActivitySource(
  db: OrchestrationDb,
  party: string,
  runtime: ActivityRuntime & Pick<OrcaRuntimeService, 'subscribeAgentStatusRowChanges'>
): { refresh: () => number | null; subscribe: (wake: () => void) => () => void } {
  const panes = new Set<string>()
  const seen = new Map<string, string>()
  const signature = (pane: string) => paneSignature(paneStatuses(runtime, pane), Date.now())
  return {
    refresh: () => {
      const expiresAt = refreshWorkerDockActivity(db, party, runtime, panes)
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

/** The host normalizes each represented status episode once; replay and heartbeats keep its time. */
export function refreshWorkerDockActivity(
  db: OrchestrationDb,
  party: string,
  runtime: ActivityRuntime,
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
  // Only the panes these workers run in are read, never every pane's status.
  const byPane = new Map<string, AgentStatusIpcPayload | undefined>()
  const statusOf = (pane: string) => {
    if (!byPane.has(pane)) {
      byPane.set(pane, paneStatuses(runtime, pane).at(-1))
    }
    return byPane.get(pane)
  }
  const sessionFor = createSessionWorkerLivenessReader(db, (pane) => {
    // A structured worker's status lives at its session's derived pane, not its minted assignee pane.
    panes?.add(pane)
    const status = statusOf(pane)
    return status
      ? mintFleetAgentStatusEvidence(status, { kind: 'unresolved', reason: 'pane_not_bound' })
      : undefined
  })
  const store = activityStore(db)
  const previous = store.bySource.get(source)
  // Only the source's ready workers are kept, so a settled or deleted worker's entry goes with it.
  const next = new Map<string, WorkerDockActivity>()
  let changed = previous !== undefined && previous.size !== candidates.length
  for (const row of candidates) {
    const id = String(row.id)
    const subject = {
      agentTerminalHandle: typeof row.assignee_handle === 'string' ? row.assignee_handle : null,
      resource: {
        processIncarnation:
          typeof row.process_incarnation === 'string' ? row.process_incarnation : null
      }
    }
    const session = sessionFor(subject)
    // Watch a known session's pane even while unverifiable, so its coming up wakes the dock.
    // No db: sessionFor already loaded any durable identity into memory, so this adds no SQL.
    const known =
      chatAssigneeSessionId(subject.agentTerminalHandle) ??
      structuredWorkerSessionIdOf(subject, null)
    if (known) {
      panes?.add(structuredAgentSessionPaneKey(structuredAgentSessionTabId(known), known))
    }
    const pane =
      session?.status === 'live' && session.activity
        ? session.activity.activity.paneKey
        : typeof row.assignee_pane_key === 'string'
          ? row.assignee_pane_key
          : null
    const observed = pane ? runtime.readObservedAgentStatusPaneIdentityFn(pane) : null
    const status = pane ? statusOf(pane) : undefined
    const bound =
      observed?.kind === 'observed' &&
      observed.dispatchId === id &&
      observed.terminalHandle === row.assignee_handle &&
      runtime.getAgentStatusTerminalHandleForPaneKey(pane!) === observed.terminalHandle &&
      runtime.getTerminalProcessIncarnation(observed.terminalHandle) ===
        observed.processIncarnation &&
      (!row.process_incarnation || row.process_incarnation === observed.processIncarnation)
    const fresh =
      (session ? session.status === 'live' : bound) && status && statusFresh(status, now)
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
    const kept = previous?.get(id)
    if (kept?.episode === episode) {
      next.set(id, kept)
    } else {
      next.set(id, { episode, state, changedAt: now })
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
