// The host's attach, lifted out of the host class.
//
// Attach is the one operation that touches every collaborator the host owns — the lease
// reconciler, the recovery resolver, the event sink, the journal, the subscriber set and the task
// queue — so leaving it inline made the host grow every time any of them did. The host keeps the
// state; this owns the ordering between them.

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { retryPendingStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  admitRecoveryTicket?: () => boolean
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const attaching = context.serialize(sessionId, async () => {
    if (admitRecoveryTicket && !admitRecoveryTicket()) {
      return refuseAgentSessionMutation({
        code: 'agent_session_checkpoint_stale',
        message: 'The provider-exit recovery ticket is no longer current.'
      })
    }
    const unreconciled = await context.reconcileLeases(sessionId)
    if (unreconciled) {
      return refuseAgentSessionMutation(unreconciled)
    }
    await context.runtimeState.resolveRecovery(sessionId)
    // Retries a durable provider-exit journal settlement before a new owner is reserved. Answers
    // settled when the record has none pending, so every attach can ask unconditionally.
    const settled = await retryPendingStructuredAgentSessionSettlement({
      deps: context.deps,
      sessions: context.sessions,
      sessionId,
      params,
      now: () => context.now()
    })
    if (!settled) {
      return refuseAgentSessionMutation({
        code: 'agent_session_ownership_unknown',
        message: 'The provider-exit terminal journal settlement is still pending; retry attach.'
      })
    }
    const eventSink = context.runtimeState.eventSinkFor(sessionId)
    const attached = await performAttach({
      store: context.deps.store,
      adapter: context.deps.adapter,
      journalRoot: context.deps.journalRoot,
      eventSink: eventSink.sink,
      onAcquiring: async () => {
        const barrier = await eventSink.drained()
        if (!barrier.ok) {
          throw barrier.error
        }
        eventSink.unbind()
      },
      authority: {
        spawnToken: () => context.deps.mintSpawnToken?.() ?? randomUUID(),
        claimKeyId: context.deps.claimKeyId,
        handoffOperationId: params.envelope.clientOperationId,
        probe: await context.runtimeState.probeOwner(sessionId),
        ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
        ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params))
      },
      callerKey,
      params,
      now: () => context.now(),
      // Site 9: this closes the PRIOR map entry it drops, never the provisional
      // journal — it has no reference to that one. `onAttached` owns that.
      onAttachFailed: async () => {
        await context.sessions.get(sessionId)?.journal.close()
        context.sessions.delete(sessionId)
        eventSink.close()
        context.runtimeState.discardEventSink(sessionId)
      },
      onAttached: async (attached, acquisitionGeneration) => {
        const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
        const previous = context.sessions.get(sessionId)
        const previousFence = previous?.fence
        // Site 8: the provisional journal has no owner until the map takes it,
        // and the barrier below throws by design.
        try {
          await bindAndDrain(eventSink, attached.journal, fence, () =>
            context.subscribers.publish(sessionId, attached.journal)
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
        context.sessions.set(sessionId, {
          journal: attached.journal,
          params,
          fence,
          hasProviderChild: true,
          acquisitionGeneration: acquisitionGeneration ?? previous?.acquisitionGeneration ?? null
        })
        if (attached.recovery) {
          context.subscribers.reset(sessionId, attached.journal, attached.recovery.reset, fence)
        } else if (previousFence !== undefined && previousFence !== fence) {
          context.subscribers.snapshot(sessionId, attached.journal, fence)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
      }
    })
    // Why: a failed attach that left no session behind must not strand a bound sink; the runtime
    // caches one per session id and would hand this same closed instance to the next attempt.
    if (!attached.ok && !context.sessions.has(sessionId)) {
      eventSink.close()
      context.runtimeState.discardEventSink(sessionId)
    }
    return attached
  })
  return context.tasks.trackAttach(attaching)
}

/** Binds the sink to the journal and waits for the barrier the host publishes
 *  behind. It throws by design when a sink barrier fails. */
async function bindAndDrain(
  eventSink: DeferredStructuredAgentSessionEventSink,
  journal: AgentSessionJournal,
  fence: number,
  publish: () => void
): Promise<void> {
  eventSink.bind({ journal, fence, publish })
  const barrier = await eventSink.drained()
  if (!barrier.ok) {
    throw barrier.error
  }
}
