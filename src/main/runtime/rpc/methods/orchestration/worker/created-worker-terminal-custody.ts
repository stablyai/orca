import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { requireWorkerAuthority } from './worker-topology'

/** Record created PTY custody before boot so user input can revoke ownership before worker-release cleanup.
 * Dispatch authority still waits for readiness; reused caller panes and structured sessions have no custody gap. */
export function recordCreatedWorkerTerminalCustody(
  runtime: OrcaRuntimeService,
  stage: {
    db: OrchestrationDb
    dispatchId: string
    worktreeId: string
    terminalHandle: string
    /** A new workspace's worker whose caller stopped waiting: kept open as a ready start would be. */
    keepOpen?: boolean
    /** Set once custody exists, cleared once recorded; dies with this start. */
    retainOwed?: boolean
  },
  created: boolean
): void {
  if (!created) {
    return
  }
  const authority = requireWorkerAuthority(runtime, stage.terminalHandle)
  stage.db.recordCreatedWorkerTerminalCustody({
    dispatchId: stage.dispatchId,
    handle: stage.terminalHandle,
    paneKey: authority.paneKey,
    processIncarnation: authority.processIncarnation,
    worktreeId: stage.worktreeId,
    hostScope: authority.hostScope ?? null
  })
  stage.retainOwed = stage.keepOpen
  retainKeptOpenWorkerTerminal(stage)
}

/**
 * Keep-open is resource policy, never a condition of the accepted task: a failed write is logged and
 * tried once more just before delivery, so the worker's report still cannot arm an automatic close first.
 */
export function retainKeptOpenWorkerTerminal(stage: {
  db: OrchestrationDb
  dispatchId: string
  retainOwed?: boolean
}): void {
  if (!stage.retainOwed) {
    return
  }
  try {
    stage.db.retainWorkerTerminalResource(stage.dispatchId)
    stage.retainOwed = false
  } catch (error) {
    console.warn('[orchestration] worker keep-open was not recorded', stage.dispatchId, error)
  }
}
