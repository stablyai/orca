import type { OrchestrationCallerShowResult } from '../../../../../shared/orchestration-caller-status'
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
      const handle = orchestrationCompatibilityEvidence?.terminalHandle
      if (!handle) {
        return { caller: null }
      }
      const identity = runtime.resolveTerminalIdentity(handle)
      return { caller: { kind: 'terminal', address: identity.handle, live: identity.live } }
    }
  })
]
