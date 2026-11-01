import type { OrchestrationDb } from './orchestration/db'
import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import { createCanonicalSessionPaneResolver } from './orchestration/structured-session-lineage'
import { isStructuredWorkerHandle } from '../../shared/structured-worker-handle'

export function createOrchestrationProjectionScope(
  db: OrchestrationDb | null,
  deps: RuntimeAgentOrchestrationDependencies
) {
  const tasks = new Map<string, ReturnType<OrchestrationDb['getTask']>>()
  const runs = new Map<string, ReturnType<OrchestrationDb['getRun']>>()
  const panes = new Map<string, ReturnType<OrchestrationDb['runsBoundToPane']>>()
  const now = Date.now()
  const resolve = createCanonicalSessionPaneResolver(deps.getSessionRecords())
  return {
    now,
    resolve,
    sessionDispatches: () => {
      const destinations = new Map<
        string,
        ReturnType<OrchestrationDb['listSessionDispatchesForPresentation']>[number]
      >()
      for (const candidate of db?.listSessionDispatchesForPresentation(now) ?? []) {
        if (!candidate.dispatch.assignee_orca_session_id) {
          continue
        }
        const paneKey = resolve(candidate.dispatch.assignee_orca_session_id)
        const previous = destinations.get(paneKey)
        const active =
          candidate.dispatch.status === 'pending' || candidate.dispatch.status === 'dispatched'
        const previousActive =
          previous?.dispatch.status === 'pending' || previous?.dispatch.status === 'dispatched'
        if (
          !previous ||
          (active && !previousActive) ||
          (active === previousActive && candidate.order > previous.order)
        ) {
          destinations.set(paneKey, candidate)
        }
      }
      return destinations
    },
    resolveTerminal: (storedHandle: string | null | undefined, storedPaneKey: string | null) =>
      resolveLivePane(deps, storedHandle, storedPaneKey),
    task: (id: string, run: string) => {
      const key = `${run}:${id}`
      if (!tasks.has(key)) {
        tasks.set(key, db?.getTask?.(id, run))
      }
      return tasks.get(key)
    },
    run: (id: string) => {
      if (!runs.has(id)) {
        runs.set(id, db?.getRun?.(id))
      }
      return runs.get(id)
    },
    paneRuns: (id: string) => {
      if (!panes.has(id)) {
        panes.set(id, db?.runsBoundToPane?.(id) ?? [])
      }
      return panes.get(id) ?? []
    }
  }
}

/** Never publish stale process-local handles; re-resolve the durable pane key, retaining it while offline so restored rows can nest again. */
function resolveLivePane(
  deps: RuntimeAgentOrchestrationDependencies,
  storedHandle: string | null | undefined,
  storedPaneKey: string | null
): { handle?: string; paneKey?: string } {
  // Structured mailbox panes are credentials, including stale rows with no current public proof.
  if (isStructuredWorkerHandle(storedHandle)) {
    return {}
  }
  if (storedHandle && deps.getWorktreeId(storedHandle) !== null) {
    return {
      handle: storedHandle,
      paneKey: deps.getPaneKey(storedHandle) ?? storedPaneKey ?? undefined
    }
  }
  if (storedPaneKey?.startsWith('structured-agent-session-')) {
    return {}
  }
  if (!storedPaneKey) {
    return {}
  }
  const liveHandle = deps.getHandleForPaneKey(storedPaneKey)
  if (isStructuredWorkerHandle(liveHandle)) {
    return {}
  }
  if (!liveHandle) {
    return { paneKey: storedPaneKey }
  }
  return { handle: liveHandle, paneKey: deps.getPaneKey(liveHandle) ?? storedPaneKey }
}
