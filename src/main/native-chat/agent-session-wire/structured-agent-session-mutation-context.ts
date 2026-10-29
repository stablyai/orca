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
  publishConversationName?: (sessionId: string) => void
  /** For callers outside session serialization. */
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
  /** Display-admitted child records used by command admission. */
  readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  publishChildWork: (sessionId: string, evidence: AgentChildWorkEvidence[]) => void
  /** Republish held-work changes without journal rows. */
  publishWorkChanged: (sessionId: string) => void
  captureChildWorkStops: (sessionId: string, handleIds: readonly string[]) => CapturedChildWorkStops
  /** Includes running child work without records. */
  childWorkOpen: (sessionId: string) => boolean
  childWorkIncomplete: (sessionId: string) => boolean
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Open within the caller’s existing serialization. */
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  /** Claim inside serialization; await the result outside. */
  claimAgent: (sessionId: string) => StructuredAgentSessionStartClaim
  startFlights: Pick<StructuredAgentSessionStartFlights, 'get'>
  startupAttempts: Pick<StructuredAgentSessionStartupAttempts, 'readiness'>
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  /** Join without starting a child, inside existing serialization. */
  joinChildClose: (sessionId: string) => Promise<AgentSessionMutationSessionPreparation>
  wakeDelivery: (sessionId: string) => void
  /** Stop the provider child inside serialization, retaining the conversation. */
  stopAgent: (sessionId: string, ending: StructuredAgentSessionStopEnding) => Promise<void>
  /** Wake for row-free record-store gates; draft writes already notify through journal commits. */
  wakeQueuedDrain?: (sessionId: string) => void
  /** Abort provider waits from outside the serialization they block. */
  acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'abort' | 'begin' | 'captureOperations'>
  /** Advance on accepted child picks so earlier reports cannot persist stale values. */
  now: () => number
}

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

/** Caller already holds session serialization. */
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
