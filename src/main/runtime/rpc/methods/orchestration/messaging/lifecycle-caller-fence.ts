import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'

/**
 * Refuses a worker report or question sent from another orchestration party's terminal: a Run
 * coordinator or the assignee of a different Dispatch. Env that names no live pane on this host
 * (stale, foreign, scrubbed, absent), or a live pane that is no party, proves nothing and passes.
 * Accepted limit: a tmux server keeps the env of the pane that started it, so a worker inside a tmux
 * server started from a live coordinator or worker pane is refused.
 */
export function assertLifecycleCallerIsNotAnotherParty(
  runtime: OrcaRuntimeService,
  args: {
    from: string
    fromPaneKey: string | undefined
    evidence: OrchestrationCompatibilityEvidence | undefined
  }
): void {
  const { evidence } = args
  // Why pane key first: the env handle goes stale on remint, the pane key does not.
  const callerHandle = evidence?.paneKey
    ? runtime.getTerminalHandleForPaneKey(evidence.paneKey)
    : evidence?.terminalHandle
  const callerPaneKey = callerHandle ? runtime.getLiveTerminalPaneKey(callerHandle) : null
  if (
    !callerHandle ||
    !callerPaneKey ||
    (args.fromPaneKey && isEquivalentPaneKey(callerPaneKey, args.fromPaneKey))
  ) {
    return
  }
  const db = runtime.getOrchestrationDb()
  const callerDispatchId = ownedDispatchId(db, callerHandle, callerPaneKey)
  // Why: a stale --from handle can hide the worker's own terminal; only a different party is refused.
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
