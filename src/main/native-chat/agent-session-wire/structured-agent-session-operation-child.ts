// The child an operation that needs the provider runs on, and the refusal of one that did not run.

import { refuse, refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { openForProviderWrite } from './structured-agent-session-send-preparation'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import type { AgentSessionMutationSessionPreparation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'

export type ReadyOperationChild = StructuredAgentSessionProviderChildIdentity | null
export type ReadyOperationSelection = {
  ok: true
  child: ReadyOperationChild
  replay?: true
  signal?: AbortSignal
  deadline?: number
}

export function operationDidNotRun(expired = false): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return {
    ok: false,
    refusal: expired
      ? refuse(
          'agent_session_operation_expired',
          { reason: 'operationExpired' },
          'The operation did not run because its wait expired. Try again.'
        )
      : refuseUnclassified(
          'agent_session_owner_restart_failed',
          'The operation did not run because the agent is not ready.'
        )
  }
}

/** The child an operation runs on, and its readiness while it starts; a null child means none is
 *  there to run on, and one must start first. */
export function selectStructuredAgentSessionOperationChild(
  context: StructuredAgentSessionMutationContext,
  sessionId: string
):
  | { ok: false; refusal: AgentSessionWireRefusal }
  | {
      ok: true
      child: StructuredAgentSessionProviderChildIdentity | null
      readiness: StructuredAgentSessionStartReadiness | null
    } {
  const child = context.sessions.get(sessionId)?.child
  if (!child || child.close) {
    return { ok: true, child: null, readiness: null }
  }
  const identity = { generation: child.generation, fence: child.fence }
  if (child.phase === 'ready') {
    return { ok: true, child: identity, readiness: null }
  }
  const readiness = context.startupAttempts.readiness(sessionId, identity)
  return readiness ? { ok: true, child: identity, readiness } : operationDidNotRun()
}

/** Replay uses the ledger answer; a new operation uses only its selected ready child. */
export function openWithReadyStructuredAgentSessionChild(
  context: StructuredAgentSessionMutationContext,
  envelope: AgentSessionMutationEnvelope,
  selection: ReadyOperationSelection
): (ledger: 'admit' | 'replay') => Promise<AgentSessionMutationSessionPreparation> {
  return async (ledger) => {
    const opened = await openForProviderWrite(context, envelope)()
    if (!opened.ok || ledger === 'replay') {
      return opened
    }
    if (selection.signal?.aborted) {
      return operationDidNotRun()
    }
    if (!selection.child) {
      return selection.replay
        ? { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
        : operationDidNotRun()
    }
    if (selection.deadline !== undefined && Date.now() >= selection.deadline) {
      return operationDidNotRun(true)
    }
    const child = context.sessions.get(envelope.sessionId)?.child
    return child?.phase === 'ready' && !child.close && sameProviderChild(child, selection.child)
      ? opened
      : operationDidNotRun()
  }
}
