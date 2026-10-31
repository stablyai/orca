import {
  agentSessionRefusalFromReference,
  refuse,
  refuseUnclassified
} from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import {
  operationDidNotRun,
  selectStructuredAgentSessionOperationChild
} from './structured-agent-session-operation-child'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { recordStructuredAgentSessionStartFailure } from './structured-agent-session-start-failure-row'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import {
  type StructuredAgentSessionStartFailureCause,
  structuredAgentSessionStartFailure,
  structuredAgentSessionStartFailureFact,
  typedStartRefusal
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import type { AgentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'

// A terminal handing its conversation to the chat that already holds it: the chat's agent starts
// through the one operation start (its provider open imports the terminal's turns), and only that
// same child reaching ready is success. Its ended child's typed failure is the click's refusal.

export type StructuredAgentSessionSwitchToChatOutcome =
  | { ok: true }
  | { ok: false; refusal: AgentSessionWireRefusal; failureItemId?: string }

async function selectSwitchStart(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  deadline?: AgentSessionSwitchDeadline
) {
  return context.serialize(sessionId, async () => {
    deadline?.check()
    if (!(await context.openConversation(sessionId))) {
      return operationDidNotRun()
    }
    deadline?.check()
    const selection = selectStructuredAgentSessionOperationChild(context, sessionId)
    return selection.ok && !selection.child
      ? { ...selection, start: context.claimAgent(sessionId, deadline?.check, true) }
      : { ...selection, start: null }
  })
}

export async function openStructuredAgentSessionForSwitch(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  deadline?: AgentSessionSwitchDeadline
) {
  const selected = await selectSwitchStart(context, sessionId, deadline)
  return {
    owned: selected.ok && Boolean(selected.start?.ownsStart),
    outcome: finishSwitchStart(context, sessionId, selected, deadline)
  }
}

export async function startStructuredAgentSessionForSwitch(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  deadline?: AgentSessionSwitchDeadline
): Promise<StructuredAgentSessionSwitchToChatOutcome> {
  return (await openStructuredAgentSessionForSwitch(context, sessionId, deadline)).outcome
}

async function finishSwitchStart(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  selected: Awaited<ReturnType<typeof selectSwitchStart>>,
  deadline?: AgentSessionSwitchDeadline
): Promise<StructuredAgentSessionSwitchToChatOutcome> {
  if (!selected.ok) {
    return { ok: false, refusal: selected.refusal }
  }
  let { child, readiness } = selected
  if (!child) {
    const started: StructuredAgentSessionResumeOutcome = await (selected.start?.outcome ??
      operationDidNotRun())
    if (!started.ok) {
      const result = started.failure
        ? switchStartFailure(context, sessionId, { failure: started.failure })
        : { ok: false as const, refusal: started.refusal }
      return {
        ...result,
        ...(deadline && started.failureItemId ? { failureItemId: started.failureItemId } : {})
      }
    }
    const selection = selectStructuredAgentSessionOperationChild(context, sessionId)
    if (!selection.ok || !selection.child) {
      return selection.ok ? operationDidNotRun() : selection
    }
    child = selection.child
    readiness = selection.readiness
  }
  const outcome =
    (await readiness?.wait(
      Math.min(STRUCTURED_AGENT_SESSION_START_WAIT_MS, deadline?.remaining() ?? Infinity)
    )) ?? 'ready'
  const awaited = child
  return context.serialize(sessionId, async () => {
    return switchStartVerdict(context, sessionId, awaited, outcome, Boolean(deadline))
  })
}

/** Under the queue: the awaited child itself is ready, or its own end says why it is not. */
async function switchStartVerdict(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  awaited: StructuredAgentSessionProviderChildIdentity,
  outcome: 'ready' | 'ended' | 'timeout',
  execution: boolean
): Promise<StructuredAgentSessionSwitchToChatOutcome> {
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
  const failureItemId =
    execution && session
      ? await recordStructuredAgentSessionStartFailure(
          {
            journal: session.journal,
            fence: context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
          },
          {
            startKey: awaited.generation,
            ...structuredAgentSessionStartFailure(
              failure,
              structuredAgentSessionFailureWordsContext(context.deps.store.getRecord(sessionId))
            )
          },
          null
        )
      : undefined
  return {
    ...switchStartFailure(context, sessionId, failure),
    ...(failureItemId ? { failureItemId } : {})
  }
}

function switchStartFailure(
  context: StructuredAgentSessionMutationContext,
  sessionId: string,
  failure: StructuredAgentSessionStartFailureCause
): StructuredAgentSessionSwitchToChatOutcome {
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
