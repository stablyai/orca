import type {
  OrchestrationCallerAddress,
  OrchestrationCallerShowResult
} from '../../../../../shared/orchestration-caller-status'
import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration-compatibility-evidence'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { defineMethod } from '../../core'

export const ORCHESTRATION_CALLER_METHODS = [
  defineMethod({
    name: 'orchestration.callerShow',
    params: null,
    // Why no params: the answer comes from the identity the caller's environment carries, which the
    // dispatch entry already resolved (a session) or the envelope evidence names (a terminal).
    // A session the entry cannot admit never reaches here: its refusal is the answer.
    handler: (
      _params,
      { runtime, orchestrationCaller, orchestrationCompatibilityEvidence }
    ): OrchestrationCallerShowResult => {
      if (orchestrationCaller) {
        return {
          caller: {
            kind: 'session',
            address: orchestrationCaller.actor,
            sessionId: orchestrationCaller.sessionId,
            live: true
          }
        }
      }
      return { caller: resolveTerminalCaller(runtime, orchestrationCompatibilityEvidence) }
    }
  })
]

/**
 * The ladder the coordinator verbs climb for a terminal caller: the handle the environment carries
 * while it is live, else the handle its pane was reminted as. Answering the stale handle instead
 * would hand out a mailbox nothing reads.
 */
function resolveTerminalCaller(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | undefined
): OrchestrationCallerAddress | null {
  const handle = evidence?.terminalHandle
  if (handle) {
    const identity = runtime.resolveTerminalIdentity(handle)
    if (identity.live) {
      return { kind: 'terminal', address: identity.handle, live: true }
    }
  }
  const reminted = evidence?.paneKey ? resolvePaneHandle(runtime, evidence.paneKey) : null
  if (reminted) {
    return { kind: 'terminal', address: reminted, live: true }
  }
  return handle ? { kind: 'terminal', address: handle, live: false } : null
}

function resolvePaneHandle(runtime: OrcaRuntimeService, paneKey: string): string | null {
  try {
    return runtime.resolveTerminalPane(paneKey).handle
  } catch (error) {
    // Why: the verbs treat an unresolvable pane as no remint, not as a failed call.
    if (error instanceof Error && error.message === 'terminal_not_found') {
      return null
    }
    throw error
  }
}
