import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration/orchestration-compatibility-evidence'
import type { RpcCallerIdentity } from '../../../rpc/callers/rpc-caller-identity'
import { isEquivalentPaneKey } from '../../db/pane-key-match'
import { bindWorkerTerminal } from '../../db/worker-terminal/worker-bound-terminals'
import { resolveStructuredWorkerIdentityForSession } from '../../terminal-authority/structured-sessions/structured-worker-authority'

/** `orca terminal create` run by a worker's own agent binds the new terminal to that worker, so it closes
 *  with it. People's windows and phones send no caller, and any other agent's terminal or chat names no
 *  worker, so their terminals get no owner; nor does one created with --keep-open. */
export function bindTerminalToCallingWorker(
  runtime: Pick<OrcaRuntimeService, 'getExistingOrchestrationDb' | 'getTerminalPaneKey'>,
  caller: {
    caller?: RpcCallerIdentity
    orchestrationCompatibilityEvidence?: OrchestrationCompatibilityEvidence
  },
  terminalHandle: string,
  keepOpen: boolean
): void {
  const evidence = caller.orchestrationCompatibilityEvidence
  const db =
    !keepOpen && caller.caller?.kind === 'local-cli' && evidence
      ? runtime.getExistingOrchestrationDb()
      : null
  if (!db || !evidence) {
    return
  }
  const workerHandle = evidence.agentSessionId
    ? resolveStructuredWorkerIdentityForSession(evidence.agentSessionId, db)?.handle
    : evidence.terminalHandle
  const resource = workerHandle ? db.getWorkerTerminalResourceByHandle(workerHandle) : undefined
  if (
    !workerHandle ||
    resource?.ownership_state !== 'owned' ||
    resource.release_state === 'released' ||
    resource.terminal_handle !== workerHandle
  ) {
    return
  }
  // A shell that kept a stale handle must not bind to whatever terminal now has it.
  const callerPane = runtime.getTerminalPaneKey(workerHandle)
  const paneKey = runtime.getTerminalPaneKey(terminalHandle)
  if (
    !paneKey ||
    !callerPane ||
    !resource.pane_key ||
    !isEquivalentPaneKey(callerPane, resource.pane_key)
  ) {
    return
  }
  bindWorkerTerminal(db, {
    dispatchId: resource.origin_dispatch_id,
    terminalHandle,
    paneKey,
    role: 'created'
  })
}
