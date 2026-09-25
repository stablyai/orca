import { recoverStructuredRewind } from './structured-rewind-recovery'
import { recoverInterruptedCompaction } from './structured-compaction-recovery'
// The host's attach, lifted out of the host class.
//
// Attach is the one operation that touches every collaborator the host owns — the lease
// reconciler, the recovery resolver, the event sink, the journal, the subscriber set and the task
// queue — so leaving it inline made the host grow every time any of them did. The host keeps the
// state; this owns the ordering between them.

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import { stampFailedCreateOwnerVerdict } from './structured-agent-session-failed-create-refusal'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { retryPendingStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import { settleStaleSessionStateOnAcquire } from './structured-agent-session-stale-turn-verdict'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import {
  endProviderChild,
  indexProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  addAgentSessionCreatePhaseAttributes,
  withAgentSessionCreatePhase,
  withAgentSessionSpan,
  type AgentSessionCreatePhaseRecorder
} from '../../observability/agent-session-instrumentation'

export type StructuredAgentSessionAttachOptions = {
  /** Provider-exit recovery: refuses once the ticket the restart was issued for is stale. */
  admitRecoveryTicket?: () => boolean
  recordPhase?: AgentSessionCreatePhaseRecorder
}

/**
 * The attach itself, for a caller already inside the session's serialize.
 *
 * That is every caller that has to know what the session looks like RIGHT NOW: a hold, a send
 * making sure it has an owner, provider-exit recovery. They run their
 * check and this attach in one serialized step, so "the session has no child" is still true when
 * the attach starts. `attachStructuredAgentSession` is this under `serialize`, for a client.
 */
export function attachStructuredAgentSessionUnderSerialize(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return context.tasks.trackAttach(runAttach(context, callerKey, params, options))
}

export function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  // Tracked from enqueue, not from its turn on the queue: a quit drains a queued attach before it
  // evicts, so no child is spawned behind the eviction and orphaned.
  const run = (recordPhase?: AgentSessionCreatePhaseRecorder) =>
    context.tasks.trackAttach(
      context.serialize(sessionId, () => runAttach(context, callerKey, params, { recordPhase }))
    )
  if (params.envelope.expectedRuntimeFence !== null) {
    return run()
  }
  return withAgentSessionSpan(async (span) => {
    const startedAtMs = Date.now()
    const phases: Parameters<AgentSessionCreatePhaseRecorder>[0][] = []
    try {
      return await run((timing) => phases.push(timing))
    } finally {
      addAgentSessionCreatePhaseAttributes(span, {
        totalDurationMs: Math.max(0, Date.now() - startedAtMs),
        phases
      })
    }
  })
}

async function runAttach(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const recordPhase = options.recordPhase
  // Readers of a conversation already open are re-baselined when this attach moves its fence.
  const fenceBefore = context.sessions.has(sessionId)
    ? structuredAgentSessionConversationFence(context.deps.store, sessionId)
    : null
  if (options.admitRecoveryTicket && !options.admitRecoveryTicket()) {
    return refuseAgentSessionMutation({
      code: 'agent_session_checkpoint_stale',
      message: 'The provider-exit recovery ticket is no longer current.'
    })
  }
  const unreconciled = await withAgentSessionCreatePhase('reconcile_leases', recordPhase, () =>
    context.reconcileLeases(sessionId)
  )
  if (unreconciled) {
    return refuseAgentSessionMutation(unreconciled)
  }
  await withAgentSessionCreatePhase('resolve_recovery', recordPhase, () =>
    context.runtimeState.resolveRecovery(sessionId)
  )
  // Retries a durable provider-exit journal settlement before a new owner is reserved. Answers
  // settled when the record has none pending, so every attach can ask unconditionally.
  const settled = await withAgentSessionCreatePhase('settlement_retry', recordPhase, () =>
    retryPendingStructuredAgentSessionSettlement({
      deps: context.deps,
      sessionId,
      openJournal: async () => (await context.openConversation(sessionId))?.journal ?? null,
      now: () => context.now()
    })
  )
  if (!settled) {
    return refuseAgentSessionMutation({
      code: 'agent_session_ownership_unknown',
      message: 'The provider-exit terminal journal settlement is still pending; retry attach.'
    })
  }
  const probe = await withAgentSessionCreatePhase('probe_owner', recordPhase, () =>
    context.runtimeState.probeOwner(sessionId)
  )
  // A child this attach spawns writes through a sink this attempt owns. Only a successful
  // attach makes the child and its sink the session's; any other exit closes the sink with
  // whatever the child queued, and leaves the conversation's child as it was.
  const attemptSink = context.runtimeState.mintEventSink(sessionId)
  const attempt: { candidate: AttachCandidate | null; committed: boolean } = {
    candidate: null,
    committed: false
  }
  try {
    const attached = await performAttach({
      store: context.deps.store,
      adapter: context.deps.adapter,
      journalRoot: context.deps.journalRoot,
      eventSink: attemptSink.sink,
      // The superseded child's writes settle into its own journal before a new child starts.
      onAcquiring: async () => {
        const barrier = await context.runtimeState.currentEventSink(sessionId)?.drained()
        if (barrier && !barrier.ok) {
          throw barrier.error
        }
      },
      authority: {
        spawnToken: () => context.deps.mintSpawnToken?.() ?? randomUUID(),
        claimKeyId: context.deps.claimKeyId,
        handoffOperationId: params.envelope.clientOperationId,
        probe,
        ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
        ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params))
      },
      callerKey,
      params,
      now: () => context.now(),
      recordPhase,
      openConversation: async (id) => {
        const conversation = await context.openConversation(id)
        if (!conversation) {
          throw new Error('agent_session_identity_required')
        }
        return conversation.journal
      },
      // The cleanup released the acquisition, which for a re-attach is the live child itself.
      onAcquisitionReleased: (cause) => endReleasedChild(context, sessionId, cause),
      onAttached: async (attached, acquisitionGeneration, acquiredOwner, providerChildPhase) => {
        const fence = structuredAgentSessionConversationFence(context.deps.store, sessionId)
        const current = context.sessions.get(sessionId)?.child ?? null
        // A re-attach to a live child keeps the sink that child already writes through.
        const eventSink = acquiredOwner
          ? attemptSink
          : (context.runtimeState.currentEventSink(sessionId) ?? attemptSink)
        if (acquiredOwner) {
          // Before the drain: the buffered events are the new child's, never a stale row's.
          await settleStaleSessionStateOnAcquire({
            journal: attached.journal,
            sessionId,
            fence,
            acquisitionGeneration
          })
        }
        await bindAndDrain(eventSink, attached.journal, fence, (activity) =>
          context.subscribers.publish(sessionId, attached.journal, activity)
        )
        attempt.candidate = {
          sink: eventSink,
          child: {
            generation: acquisitionGeneration ?? current?.generation ?? null,
            fence,
            // A re-attach to a live child keeps what that child already proved.
            phase: acquiredOwner ? providerChildPhase : (current?.phase ?? 'ready')
          }
        }
        await recoverStructuredRewind(
          context.deps.store,
          sessionId,
          attached.journal,
          fence,
          context.deps.adapter,
          context.now
        )
        await recoverInterruptedCompaction(context.deps.store, sessionId, attached.journal, fence)
        if (fenceBefore !== null && fence !== fenceBefore) {
          context.subscribers.snapshot(sessionId, attached.journal, fence)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
      }
    })
    const { candidate } = attempt
    const conversation = context.sessions.get(sessionId)
    if (attached.ok && candidate && conversation) {
      context.runtimeState.adoptEventSink(sessionId, candidate.sink)
      attempt.committed = candidate.sink === attemptSink
      indexProviderChild(conversation, candidate.child)
      context.publishStatus?.(sessionId)
    }
    return stampFailedCreateOwnerVerdict(context.deps.store, callerKey, params.envelope, attached)
  } finally {
    if (!attempt.committed) {
      attemptSink.close()
    }
  }
}

type AttachCandidate = {
  child: StructuredAgentSessionProviderChild
  sink: DeferredStructuredAgentSessionEventSink
}

function endReleasedChild(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  cause: unknown
): void {
  const session = context.sessions.get(sessionId)
  const child = session?.child
  if (
    !session ||
    !child ||
    !endProviderChild(session, {
      generation: child.generation,
      fence: child.fence,
      cause: 'attach-failed',
      reason: cause instanceof Error ? cause.message : String(cause),
      duringStartup: child.phase === 'starting'
    })
  ) {
    return
  }
  context.runtimeState.currentEventSink(sessionId)?.close()
  context.runtimeState.discardEventSink(sessionId)
  context.publishStatus?.(sessionId)
}

/** Binds the sink to the journal and waits for the barrier the host publishes
 *  behind. It throws by design when a sink barrier fails. */
async function bindAndDrain(
  eventSink: DeferredStructuredAgentSessionEventSink,
  journal: AgentSessionJournal,
  fence: number,
  publish: (activity?: AgentSessionTurnActivity | null) => void
): Promise<void> {
  eventSink.bind({ journal, fence, publish })
  const barrier = await eventSink.drained()
  if (!barrier.ok) {
    throw barrier.error
  }
}
