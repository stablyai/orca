// A terminal handing its conversation to the chat that already holds it: the chat's agent starts
// through the one operation start (its provider open imports the terminal's turns), and only that
// same child reaching ready is success. Its ended child's typed failure is the click's refusal.

import {
  agentSessionRefusalFromReference,
  refuse,
  refuseUnclassified
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import {
  operationDidNotRun,
  selectStructuredAgentSessionOperationChild
} from './structured-agent-session-operation-child'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import {
  structuredAgentSessionStartFailure,
  structuredAgentSessionStartFailureFact,
  typedStartRefusal
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'

export type StructuredAgentSessionSwitchToChatOutcome =
  | { ok: true }
  | { ok: false; refusal: AgentSessionWireRefusal }

export async function startStructuredAgentSessionForSwitch(
  context: StructuredAgentSessionMutationContext,
  sessionId: string
): Promise<StructuredAgentSessionSwitchToChatOutcome> {
  const selected = await context.serialize(sessionId, async () => {
    if (!(await context.openConversation(sessionId))) {
      return operationDidNotRun()
    }
    const selection = selectStructuredAgentSessionOperationChild(context, sessionId)
    return selection.ok && !selection.child
      ? { ...selection, start: context.claimAgent(sessionId) }
      : { ...selection, start: null }
  })
  if (!selected.ok) {
    return { ok: false, refusal: selected.refusal }
  }
  let { child, readiness } = selected
  if (!child) {
    const started = await (selected.start?.outcome ?? operationDidNotRun())
    if (!started.ok) {
      return { ok: false, refusal: started.refusal }
    }
    const selection = selectStructuredAgentSessionOperationChild(context, sessionId)
    if (!selection.ok || !selection.child) {
      return selection.ok ? operationDidNotRun() : selection
    }
    child = selection.child
    readiness = selection.readiness
  }
  const outcome = (await readiness?.wait(STRUCTURED_AGENT_SESSION_START_WAIT_MS)) ?? 'ready'
  const awaited = child
  return context.serialize(sessionId, async () =>
    switchStartVerdict(context, sessionId, awaited, outcome)
  )
}

/** Under the queue: the awaited child itself is ready, or its own end says why it is not. */
function switchStartVerdict(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  awaited: StructuredAgentSessionProviderChildIdentity,
  outcome: 'ready' | 'ended' | 'timeout'
): StructuredAgentSessionSwitchToChatOutcome {
  const session = context.sessions.get(sessionId)
  const child = session?.child
  if (outcome === 'ready' && child?.phase === 'ready' && !child.close) {
    return sameProviderChild(child, awaited) ? { ok: true } : operationDidNotRun()
  }
  const ended = session?.lastEndedChild
  const failure =
    ended && sameProviderChild(ended, awaited)
      ? structuredAgentSessionEndedChildFailure(ended)
      : null
  if (!failure) {
    return operationDidNotRun(outcome === 'timeout')
  }
  const fact = structuredAgentSessionStartFailureFact(failure)
  const { reason } = structuredAgentSessionStartFailure(
    failure,
    structuredAgentSessionFailureWordsContext(context.deps.store.getRecord(sessionId))
  )
  const typed = typedStartRefusal(fact.kind)
  const refusal: AgentSessionWireRefusal = typed
    ? refuse('agent_session_operation_invalid', { reason: typed }, reason)
    : fact.refusal
      ? agentSessionRefusalFromReference(fact.refusal, reason)
      : refuseUnclassified('agent_session_owner_restart_failed', reason)
  return { ok: false, refusal }
}
