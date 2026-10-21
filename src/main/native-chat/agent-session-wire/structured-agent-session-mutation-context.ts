// The context every client mutation of a session runs with, and the one path each takes: admit the
// envelope against the lease, then run its plan inside the session's serialize.

import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
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
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import type { CapturedChildWorkStops } from './structured-agent-session-status-ownership'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
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
  publishChildWork: (sessionId: string, evidence: AgentChildWorkEvidence[]) => void
  captureChildWorkStops: (sessionId: string, handleIds: readonly string[]) => CapturedChildWorkStops
  /** Some of the session's running child work has no record. */
  childWorkOpen: (sessionId: string) => boolean
  childWorkIncomplete: (sessionId: string) => boolean
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The session's conversation, opened when closed; inside the caller's serialize. */
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  /** Claims a provider start on the caller's lane; its outcome is awaited outside. */
  claimAgent: (sessionId: string) => StructuredAgentSessionStartClaim
  startFlights: Pick<StructuredAgentSessionStartFlights, 'get'>
  startupAttempts: Pick<StructuredAgentSessionStartupAttempts, 'readiness'>
  deliveryOrder: StructuredAgentSessionDeliveryOrder
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
  /** The provider wait each session's serialize is on (a start, an option write), which a caller
   *  outside that serialize aborts. */
  acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'abort' | 'begin' | 'captureOperations'>
  /** Moved by every pick a running child takes, so a report it read before is never persisted. */
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
    runStructuredAgentSessionMutation(context, caller, envelope, plan, prepareSession)
  )
}

/** Admission for a caller already inside the session's queue. */
export function runStructuredAgentSessionMutation<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>,
  prepareSession?: AgentSessionMutationRequest<TValue>['prepareSession']
): Promise<AgentSessionMutationResult<TValue>> {
  return admitAndRunAgentSessionMutation({
    store: context.deps.store,
    adapter: context.deps.adapter,
    agents: context.deps.agents,
    logger: context.deps.logger,
    callerKey: caller.callerKey,
    envelope,
    plan,
    journal: () => context.sessions.get(envelope.sessionId)?.journal,
    currentWork: () =>
      hostStructuredAgentSessionCurrentWork(
        { store: context.deps.store, sessions: context.sessions },
        envelope.sessionId
      ),
    prepareSession,
    publish: (journal) => context.publish(envelope.sessionId, journal),
    wakeDelivery: (sessionId) => context.wakeDelivery(sessionId),
    now: () => context.now()
  })
}
