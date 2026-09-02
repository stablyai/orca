// Everything a client can ask an ALREADY-ATTACHED session to do: send a turn, cancel one, answer a
// prompt, change an option, read the options back.
//
// They share one shape — admit the envelope against the lease, run a plan, publish the journal — so
// they share one path here rather than five copies in the host. The host keeps attach, holds and
// teardown; this is the surface that assumes those already happened.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import {
  cancelPlan,
  promptPlan,
  sendPlan,
  setOptionPlan,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type StructuredAgentSessionMutationContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  publish: (sessionId: string, journal: StructuredAgentSessionHostSession['journal']) => void
  requireSession: (sessionId: string) => StructuredAgentSessionHostSession
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
}

function mutate<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>
): Promise<AgentSessionMutationResult<TValue>> {
  return context.serialize(envelope.sessionId, () =>
    admitAndRunAgentSessionMutation({
      store: context.deps.store,
      adapter: context.deps.adapter,
      callerKey: caller.callerKey,
      envelope,
      plan,
      journal: context.sessions.get(envelope.sessionId)?.journal,
      publish: (journal) => context.publish(envelope.sessionId, journal),
      now: () => context.now()
    })
  )
}

export function sendStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    retryUnknown?: true
    beforeRun?: () => void
  }
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  return mutate(context, caller, params.envelope, sendPlan(params))
}

export function cancelStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; turnId: string }
): Promise<AgentSessionMutationResult<AgentSessionCancelResult>> {
  return mutate(context, caller, params.envelope, cancelPlan(params))
}

export function respondToStructuredAgentSessionPrompt(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    kind: 'approval' | 'question'
    itemId: string
    expectedRevision: number
    optionId: string
  }
): Promise<AgentSessionMutationResult<AgentSessionPromptResult>> {
  return mutate(context, caller, params.envelope, promptPlan(params))
}

export function setStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; key: string; value: string }
): Promise<AgentSessionMutationResult<AgentSessionOptionResult>> {
  return mutate(context, caller, params.envelope, setOptionPlan(params))
}

export function readStructuredAgentSessionOptions(
  context: StructuredAgentSessionMutationContext,
  sessionId: string
): Promise<AgentSessionOptionsResult> {
  return context.serialize(sessionId, async () => {
    const session = context.requireSession(sessionId)
    if (!context.deps.adapter.readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    return context.deps.adapter.readOptions({ sessionId, fence: session.fence })
  })
}
