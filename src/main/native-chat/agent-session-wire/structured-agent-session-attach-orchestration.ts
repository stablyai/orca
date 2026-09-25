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
import { isResumableStructuredAgentSessionRecord } from './structured-agent-session-resume-eligibility'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { forgetStructuredAgentSession } from './structured-agent-session-host-lifetime'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
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
  const probe = await withAgentSessionCreatePhase('probe_owner', recordPhase, () =>
    context.runtimeState.probeOwner(sessionId)
  )
  // A child this attach spawns writes through a sink this attempt owns. Only a successful
  // attach makes it the session's; any other exit closes it with whatever the child queued.
  const attemptSink = context.runtimeState.mintEventSink(sessionId)
  let attemptSinkAdopted = false
  // A lease handed back cleanly is what a resume replaces. A writer current as of that owner is
  // rebased onto the fence this attach publishes, since the restart is the only thing that moved it.
  const released = context.deps.store.getRecord(sessionId)
  const resumedFromFence =
    released && isResumableStructuredAgentSessionRecord(released)
      ? released.lease.runtimeFence
      : undefined
  // Read before the reserve clears it: how the previous generation ended decides how whatever it
  // left running is settled.
  const priorDeathEvidence = released?.lease.deathEvidence ?? null
  const attached = stampFailedCreateOwnerVerdict(
    context.deps.store,
    callerKey,
    params.envelope,
    await performAttach({
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
      // Site 9: this closes the PRIOR map entry it drops, never the provisional
      // journal — it has no reference to that one. `onAttached` owns that.
      onAttachFailed: async () => {
        await forgetStructuredAgentSession(context, sessionId)
        context.runtimeState.currentEventSink(sessionId)?.close()
        context.runtimeState.discardEventSink(sessionId)
      },
      onAttached: async (attached, acquisitionGeneration, acquiredOwner, providerChildPhase) => {
        const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
        const previous = context.sessions.get(sessionId)
        const previousFence = previous?.fence
        // A re-attach to a live child keeps the sink that child already writes through.
        const eventSink = acquiredOwner
          ? attemptSink
          : (context.runtimeState.currentEventSink(sessionId) ?? attemptSink)
        // Site 8: the provisional journal has no owner until the map takes it,
        // and the barrier below throws by design.
        try {
          if (acquiredOwner) {
            // Before the drain: the buffered events are the new child's, never a stale row's.
            await settleStaleStructuredAgentSessionState({
              journal: attached.journal,
              sessionId,
              fence,
              acquisitionGeneration,
              deathEvidence: priorDeathEvidence
            })
          }
          await bindAndDrain(eventSink, attached.journal, fence, (activity) =>
            context.subscribers.publish(sessionId, attached.journal, activity)
          )
        } catch (error) {
          await agentSessionJournalCloseRetries.closeOrRetain(attached.journal)
          throw error
        }
        // Site 10: a `set` over a live entry would orphan its handle — and a
        // close that REJECTED did not release it. The replacement is therefore
        // ABORTED rather than completed over a handle nothing can reach again:
        // `previous` stays indexed, so teardown still owns it and can retry.
        if (previous && previous.journal !== attached.journal) {
          try {
            await previous.journal.close()
          } catch (error) {
            await agentSessionJournalCloseRetries.closeOrRetain(attached.journal)
            throw error
          }
        }
        context.runtimeState.adoptEventSink(sessionId, eventSink)
        attemptSinkAdopted = eventSink === attemptSink
        context.sessions.set(sessionId, {
          journal: attached.journal,
          params,
          fence,
          hasProviderChild: true,
          // A re-attach to a live child keeps what that child already proved.
          providerChildPhase: acquiredOwner
            ? providerChildPhase
            : (previous?.providerChildPhase ?? 'ready'),
          acquisitionGeneration: acquisitionGeneration ?? previous?.acquisitionGeneration ?? null,
          resumedFromFence: acquiredOwner ? resumedFromFence : previous?.resumedFromFence
        })
        await recoverStructuredRewind(
          context.deps.store,
          sessionId,
          attached.journal,
          fence,
          context.deps.adapter,
          context.now
        )
        await recoverInterruptedCompaction(context.deps.store, sessionId, attached.journal, fence)
        if (attached.recovery) {
          context.subscribers.reset(sessionId, attached.journal, attached.recovery.reset, fence)
        } else if (previousFence !== undefined && previousFence !== fence) {
          context.subscribers.snapshot(sessionId, attached.journal, fence)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
      }
    }).finally(() => {
      if (!attemptSinkAdopted) {
        attemptSink.close()
      }
    })
  )
  return attached
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
