// Classifies a launch-spawn rejection: did the execution host AFFIRMATIVELY
// report the spawn failed, or did contact with the host break while the request
// was (possibly) in flight? Per docs/reference/ssh-execution-boundary.md, loss
// of contact is never evidence of process death — the relay may have spawned
// the agent before the link dropped — so a contact-loss rejection must settle
// `launch_state_unknown` (pending retained, plain Retry blocked) rather than a
// retryable `spawn_failed` that would let Retry cold-start a duplicate beside a
// live remote agent.

import { isSshMuxRequestTimeoutError } from '../ssh/ssh-channel-multiplexer'

// Codes minted by createSshDisposalError (ssh-channel-multiplexer): every relay
// request pending when the link drops or the mux is disposed rejects with one
// of these. Neither observes the remote process — the spawn may have landed.
const SSH_DISPOSAL_ERROR_CODES = new Set(['CONNECTION_LOST', 'DISPOSED'])

/** True when a spawn rejection cannot prove the execution host never spawned
 *  the agent. Recognizes the established post-dispatch ambiguity marker
 *  (`agentSessionOperationOutcome: 'unknown'`, stamped wherever the owning code
 *  already decided the outcome is unprovable) plus the SSH transport rejections
 *  that can interrupt a dispatched `pty.spawn` (disposal and request timeout). */
export function isSpawnContactLossError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const marked = error as { agentSessionOperationOutcome?: unknown; code?: unknown }
  if (marked.agentSessionOperationOutcome === 'unknown') {
    return true
  }
  return (
    (typeof marked.code === 'string' && SSH_DISPOSAL_ERROR_CODES.has(marked.code)) ||
    isSshMuxRequestTimeoutError(error)
  )
}
