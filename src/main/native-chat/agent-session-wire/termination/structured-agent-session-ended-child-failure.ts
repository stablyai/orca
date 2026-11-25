import type { StructuredAgentSessionChildExitContext } from './structured-agent-session-child-exit'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionStartFailureCause } from '../startup/structured-agent-session-failure-text'
import type { StructuredAgentSessionChildEndCause } from './structured-agent-session-stop-cause'
import type { StructuredAgentSessionEndedChild } from '../host/structured-agent-session-host-types'

function providerEndFailure(
  ended: StructuredAgentSessionEndedChild
): StructuredAgentSessionStartFailureCause {
  if (ended.duringStartup) {
    return { exit: ended.failure }
  }
  return { failure: ended.failure ?? agentSessionFailureFact('providerExited') }
}

// Exhaust causes so newly added ends must classify queued-send failure.
const ENDED_CHILD_FAILURE = {
  'user-stop': () => null,
  'user-close': () => null,
  'context-clear': () => null,
  // Host Stop is Orca’s action, not a provider failure.
  'host-stop': (ended) => ({ failure: ended.failure ?? agentSessionFailureFact('hostStopped') }),
  exit: providerEndFailure,
  'attach-failed': providerEndFailure,
  // Partial eviction failed after child shutdown but left the conversation open.
  evict: providerEndFailure
} satisfies Record<
  StructuredAgentSessionChildEndCause,
  (ended: StructuredAgentSessionEndedChild) => StructuredAgentSessionStartFailureCause | null
>

/** Null means this child end fails no queued work. */
export function structuredAgentSessionEndedChildFailure(
  ended: StructuredAgentSessionEndedChild
): StructuredAgentSessionStartFailureCause | null {
  return ENDED_CHILD_FAILURE[ended.cause](ended)
}

export function logExitFailure(
  context: Pick<StructuredAgentSessionChildExitContext, 'logger'>,
  sessionId: string,
  scope: string,
  error: unknown
): void {
  context.logger.warn('settling a provider exit did not finish', { scope, sessionId, error })
}
