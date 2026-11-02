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
  if (stage.keepOpen) {
    // Before delivery, so its report can never arm an automatic close first.
    stage.db.retainWorkerTerminalResource(stage.dispatchId)
  }
}
