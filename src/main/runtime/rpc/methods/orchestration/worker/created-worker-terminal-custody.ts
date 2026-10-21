import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { requireWorkerAuthority } from './worker-topology'

/**
 * Custody for an agent terminal this start created, recorded when the terminal exists rather than
 * after the agent boot wait: a keystroke into the booting pane has to find an `owned` row to flip,
 * or the takeover is dropped and a later `worker-release` closes the pane under the user.
 *
 * Ownership of a pane only. The Dispatch capability still waits for the agent to come up.
 *
 * `created` is false for an explicit `--terminal` reuse, which is the caller's own pane, and for a
 * structured session, which reaches its authority in this same turn and so has no gap to close.
 */
export function recordCreatedWorkerTerminalCustody(
  runtime: OrcaRuntimeService,
  stage: { db: OrchestrationDb; dispatchId: string; worktreeId: string; terminalHandle: string },
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
}
