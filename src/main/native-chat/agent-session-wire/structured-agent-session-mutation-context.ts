// The context every client mutation of a session runs with, and the one path each takes: admit the
// envelope against the lease, then run its plan inside the session's serialize.

import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  admitAndRunAgentSessionMutation,
  type AgentSessionMutationRequest,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { StructuredAgentSessionStopEnding } from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type StructuredAgentSessionMutationContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  publish: (sessionId: string, journal: StructuredAgentSessionHostSession['journal']) => void
  /** The host's accessor, for a caller outside the session's serialize. */
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
  /** The session's child records, as the strip reads them; what command admission decides on. */
  readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The session's conversation, opened when closed; inside the caller's serialize. */
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  /** Gives the session a provider child; inside the caller's serialize. */
  ensureAgent: (sessionId: string) => Promise<AgentSessionMutationSessionPreparation>
  /** Joins a close a stop began on the session's child, for an operation that starts no child;
   *  inside the caller's serialize. */
  joinChildClose: (sessionId: string) => Promise<AgentSessionMutationSessionPreparation>
  /** A message was accepted: the session's delivery loop hands it over. */
  wakeDelivery: (sessionId: string) => void
  /** Stops the session's provider child, keeping its conversation; inside the caller's serialize.
   *  Each caller names why (`ending`). */
  stopAgent: (sessionId: string, ending: StructuredAgentSessionStopEnding) => Promise<void>
  /** Only for gate inputs living in the RECORD store, which can settle with no
   *  journal commit (a conversation command). Draft-table changes need no call:
   *  the draft store notifies through the journal's own commit listener. */
  wakeQueuedDrain?: (sessionId: string) => void
  now: () => number
}

/** Admits the envelope and runs the plan inside the session's serialize. */
export function mutateStructuredAgentSession<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>,
  prepareSession?: AgentSessionMutationRequest<TValue>['prepareSession']
): Promise<AgentSessionMutationResult<TValue>> {
  return context.serialize(envelope.sessionId, () =>
    admitAndRunAgentSessionMutation({
      store: context.deps.store,
      adapter: context.deps.adapter,
      logger: context.deps.logger,
      callerKey: caller.callerKey,
      envelope,
      plan,
      journal: () => context.sessions.get(envelope.sessionId)?.journal,
      prepareSession,
      publish: (journal) => context.publish(envelope.sessionId, journal),
      providerChildPhase: () => context.sessions.get(envelope.sessionId)?.child?.phase,
      now: () => context.now()
    })
  )
}
