// The context every client mutation of a session runs with, and the one path each takes: admit the
// envelope against the lease, then run its plan inside the session's serialize.

import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  admitAndRunAgentSessionMutation,
  refuseAgentSessionMutation,
  type AgentSessionMutationRequest,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import { structuredAgentSessionOperationStartOutcome } from './structured-agent-session-agent-start'
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

/** A preparation found the agent the call needs still proving its start: the call leaves the queue
 *  to wait for it. */
class AwaitingAgentStart {
  constructor(readonly child: string) {}
}

type AdmittedPreparation = NonNullable<AgentSessionMutationRequest<unknown>['prepareSession']>
type SessionPreparation = (
  ...args: Parameters<AdmittedPreparation>
) => Promise<AgentSessionMutationSessionPreparation>

/**
 * Runs a mutation `step` in the session's queue. A preparation that leaves the agent the call needs
 * proving its start is waited on outside the queue, as the delivery loop waits, so a Stop or the
 * idle sweep can reach a start that hangs; the step then runs again and finds that child there.
 * A child that replaced it is waited on the same way: nothing waits for a start inside the queue.
 */
export async function serializeAwaitingAgentStart<TValue>(
  context: Pick<StructuredAgentSessionMutationContext, 'serialize' | 'sessions' | 'deps'>,
  sessionId: string,
  step: (
    prepare: (prepareSession: SessionPreparation) => AdmittedPreparation
  ) => Promise<AgentSessionMutationResult<TValue>>
): Promise<AgentSessionMutationResult<TValue>> {
  const { adapter } = context.deps
  let awaited: string | null = null
  const prepare =
    (prepareSession: SessionPreparation): AdmittedPreparation =>
    async (...args) => {
      const prepared = await prepareSession(...args)
      const child = context.sessions.get(sessionId)?.child
      if (!prepared.ok || !prepared.startPending || !child || !adapter.awaitStarted) {
        return prepared.ok ? { ok: true } : prepared
      }
      const identity = `${child.generation}:${child.fence}`
      if (identity !== awaited) {
        throw new AwaitingAgentStart(identity)
      }
      // Settled for the child waited on, so this answers at once: the host's phase trails the
      // adapter's by a step.
      return structuredAgentSessionOperationStartOutcome(await adapter.awaitStarted(sessionId))
    }
  for (;;) {
    try {
      return await context.serialize(sessionId, () => step(prepare))
    } catch (error) {
      if (!(error instanceof AwaitingAgentStart)) {
        throw error
      }
      const started = structuredAgentSessionOperationStartOutcome(
        await adapter.awaitStarted?.(sessionId)
      )
      if (!started.ok) {
        return refuseAgentSessionMutation(started.refusal)
      }
      awaited = error.child
    }
  }
}

/** Admits the envelope and runs the plan inside the session's serialize, a start its preparation
 *  needs waited on outside it; see `serializeAwaitingAgentStart`. */
export function mutateStructuredAgentSession<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>,
  prepareSession?: SessionPreparation
): Promise<AgentSessionMutationResult<TValue>> {
  const { sessionId } = envelope
  return serializeAwaitingAgentStart(context, sessionId, (prepare) =>
    admitAndRunAgentSessionMutation({
      store: context.deps.store,
      adapter: context.deps.adapter,
      logger: context.deps.logger,
      callerKey: caller.callerKey,
      envelope,
      plan,
      journal: () => context.sessions.get(sessionId)?.journal,
      ...(prepareSession ? { prepareSession: prepare(prepareSession) } : {}),
      publish: (journal) => context.publish(sessionId, journal),
      providerChildPhase: () => context.sessions.get(sessionId)?.child?.phase,
      now: () => context.now()
    })
  )
}
