import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import { evidenceCallerTerminal } from './evidence-caller-terminal'

/** Refuse reports/questions from a different live orchestration party; absent/stale/foreign/scrubbed env proves nothing.
 * Accepted limit: tmux inherits its starting pane's env, so a worker in a coordinator/worker-owned tmux server is refused. */
export function assertLifecycleCallerIsNotAnotherParty(
  runtime: OrcaRuntimeService,
  args: {
    from: string
    fromPaneKey: string | undefined
    evidence: OrchestrationCompatibilityEvidence | undefined
  }
): void {
  const caller = evidenceCallerTerminal(runtime, args.evidence)
  if (!caller || (args.fromPaneKey && isEquivalentPaneKey(caller.paneKey, args.fromPaneKey))) {
    return
  }
  const { handle: callerHandle, paneKey: callerPaneKey } = caller
  const db = runtime.getOrchestrationDb()
  const callerDispatchId = ownedDispatchId(db, callerHandle, callerPaneKey)
  // A stale from handle may hide the same worker; refuse only a different party.
  if (callerDispatchId && callerDispatchId === ownedDispatchId(db, args.from, args.fromPaneKey)) {
    return
  }
  const party = db.getCurrentRunForPane(callerPaneKey)
    ? 'a Run coordinator'
    : callerDispatchId
      ? 'a Dispatch worker'
      : undefined
  if (party) {
    throw new OrchestrationError(
      'consumer_fenced',
      `This terminal is ${party} and cannot report as ${args.from}; run the command from the worker's own terminal. No effects were applied.`,
      { effectsApplied: false }
    )
  }
}

function ownedDispatchId(
  db: OrchestrationDb,
  handle: string,
  paneKey: string | undefined
): string | undefined {
  return (
    db.getActiveDispatchForIdentity(handle, paneKey)?.id ??
    (paneKey ? db.findActiveRemoteAttachmentForPane(paneKey)?.dispatch_id : undefined)
  )
}
