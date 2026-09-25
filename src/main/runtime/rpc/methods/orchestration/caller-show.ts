import type {
  OrchestrationCallerAddress,
  OrchestrationCallerShowResult,
  OrchestrationSessionAddressResult
} from '../../../../../shared/orchestration-caller-status'
import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration-compatibility-evidence'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../shared/orchestration-session-caller-codes'
import { SessionAddressParams } from '../../../../../shared/rpc-contract/orchestration-params'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { resolveOrcaSessionParty } from '../../../orchestration/orchestration-party'
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
            address: formatOrcaSessionAddress(orchestrationCaller.orcaSessionId),
            sessionId: orchestrationCaller.sessionId,
            live: true
          }
        }
      }
      return { caller: resolveTerminalCaller(runtime, orchestrationCompatibilityEvidence) }
    }
  }),
  defineMethod({
    name: 'orchestration.sessionAddress',
    params: SessionAddressParams,
    // Why host-side: the party resolver derives it from the session records, which only the host
    // holds, exactly as it binds a verb acting as that session: the lineage root's address.
    handler: (params, { runtime }): OrchestrationSessionAddressResult => {
      if (!isOrcaSessionId(params.sessionId)) {
        throw new OrchestrationError(
          CODES.unknown,
          `${params.sessionId} is not an Orca agent session id.`,
          { effectsApplied: false }
        )
      }
      const party = resolveOrcaSessionParty(params.sessionId, runtime.getOrchestrationDb())
      return { address: formatOrcaSessionAddress(party.orcaSessionId) }
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
