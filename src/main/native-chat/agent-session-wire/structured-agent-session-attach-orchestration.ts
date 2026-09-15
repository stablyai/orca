import type { StructuredAgentSessionAcquireInput } from './structured-agent-session-adapter'
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
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import {
  turnVerdictFromDeathEvidence,
  UNVERIFIABLE_TURN_VERDICT
} from './structured-agent-session-stale-turn-verdict'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStructuredAgentSessionDeadGeneration,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { forgetStructuredAgentSession } from './structured-agent-session-host-lifetime'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  admitRecoveryTicket?: () => boolean,
  rewind?: StructuredAgentSessionAcquireInput['rewind']
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
    // A death hint is read before reservation clears it. Bookkeeping never gates attach or send.
    const previousLease = context.deps.store.getRecord(sessionId)?.lease
    const eventSink = context.runtimeState.eventSinkFor(sessionId)
    const attached = await performAttach({
      rewind,
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
        await forgetStructuredAgentSession(context, sessionId)
        eventSink.close()
        context.runtimeState.discardEventSink(sessionId)
      },
      onAttached: async (attached, acquisitionGeneration, acquiredOwner) => {
        const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
        const previous = context.sessions.get(sessionId)
        const previousFence = previous?.fence
        let settleAcquiredGeneration: (() => Promise<void>) | undefined
        if (acquiredOwner) {
          const verdict = turnVerdictFromDeathEvidence(previousLease?.deathEvidence)
          const throughFence = previousLease?.settlementRetryFence ?? fence - 1
          const settlementId =
            previousLease?.settlementRetryId ??
            `stale-generation:${sessionId}:${fence}:${acquisitionGeneration ?? 'unknown'}`
          const pendingSettlementWork = captureUnfinishedStructuredAgentSessionWork(
            attached.journal,
            throughFence,
            throughFence
          )
          if (
            previousLease?.settlementRetryRequired ||
            pendingSettlementWork.hadUnsettledSubmissions ||
            pendingSettlementWork.items.length > 0
          ) {
            settleAcquiredGeneration = async () => {
              // Record the obligation before doing any best-effort writes. The latch keeps a
              // failed settlement recoverable even if this owner exits before the retry finishes.
              try {
                await context.deps.store.transitionHandoff(sessionId, (latest) => {
                  if (
                    latest.lease.runtimeFence !== fence ||
                    latest.lease.claimStatus !== 'live' ||
                    latest.lease.settlementRetryRequired
                  ) {
                    return latest
                  }
                  return {
                    ...latest,
                    lease: {
                      ...latest.lease,
                      settlementRetryRequired: true,
                      settlementRetryId: settlementId,
                      settlementRetryFence: throughFence,
                      deathEvidence: previousLease?.deathEvidence ?? latest.lease.deathEvidence
                    }
                  }
                })
              } catch (error) {
                context.deps.onEventSinkError?.({ sessionId, error })
              }
              const priorSettled = await settleStructuredAgentSessionDeadGeneration({
                journal: attached.journal,
                sessionId,
                fence,
                throughFence: throughFence - 1,
                settlementId: `${settlementId}:prior`,
                verdict: UNVERIFIABLE_TURN_VERDICT,
                pendingSubmissionReason: 'provider_exited_before_acknowledgement',
                showUnexpectedExitOutcome: false,
                onError: (id, error) => context.deps.onEventSinkError?.({ sessionId: id, error })
              })
              const work = pendingSettlementWork
              const settled = await settleStructuredAgentSessionDeadGeneration({
                journal: attached.journal,
                sessionId,
                fence,
                throughFence,
                fromFence: throughFence,
                settlementId,
                verdict,
                pendingSubmissionReason: 'provider_exited_before_acknowledgement',
                submissionRecoveryMode: 'new-owner-not-publishing',
                showUnexpectedExitOutcome:
                  verdict.state === 'interrupted' &&
                  (attached.unconfirmedClientMessageIds.length > 0 ||
                    unfinishedStructuredAgentSessionWorkWasInterrupted(
                      work,
                      attached.journal,
                      verdict.completedAt,
                      throughFence,
                      throughFence
                    )),
                // A later generation has cleared the old exit detail; use generic copy then.
                ...(previousLease?.settlementRetryRequired && previousLease.deathEvidence?.detail
                  ? { unexpectedExitReason: previousLease.deathEvidence.detail }
                  : {}),
                onError: (id, error) => {
                  context.deps.onEventSinkError?.({ sessionId: id, error })
                  console.error('agent-session dead-generation settlement deferred', id, error)
                }
              })
              if (settled && priorSettled) {
                try {
                  await context.deps.store.transitionHandoff(sessionId, (latest) => ({
                    ...latest,
                    lease:
                      latest.lease.settlementRetryRequired === true &&
                      latest.lease.settlementRetryId === settlementId
                        ? {
                            ...latest.lease,
                            settlementRetryRequired: undefined,
                            settlementRetryId: undefined,
                            settlementRetryFence: undefined
                          }
                        : latest.lease
                  }))
                } catch (error) {
                  context.deps.onEventSinkError?.({ sessionId, error })
                }
              }
              // Detached writes still need a publication edge so live clients and the status feed
              // observe the durable terminal rows without waiting for another provider event.
              context.subscribers.publish(sessionId, attached.journal)
            }
          }
        }
        // Site 8: the provisional journal has no owner until the map takes it,
        // and the barrier below throws by design.
        try {
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
        context.sessions.set(sessionId, {
          journal: attached.journal,
          params,
          fence,
          hasProviderChild: true,
          acquisitionGeneration: acquisitionGeneration ?? previous?.acquisitionGeneration ?? null
        })
        if (!rewind) {
          await recoverStructuredRewind(
            context.deps.store,
            sessionId,
            attached.journal,
            fence,
            context.deps.adapter,
            context.now
          )
        }
        await recoverInterruptedCompaction(context.deps.store, sessionId, attached.journal, fence)
        if (attached.recovery) {
          context.subscribers.reset(sessionId, attached.journal, attached.recovery.reset, fence)
        } else if (previousFence !== undefined && previousFence !== fence) {
          context.subscribers.snapshot(sessionId, attached.journal, fence)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
        // Settlement is recovery bookkeeping. It may append rows after the new owner starts
        // publishing, but it must never hold the attach/send path on a storage operation that
        // does not settle.
        if (settleAcquiredGeneration) {
          void settleAcquiredGeneration().catch((error) => {
            context.deps.onEventSinkError?.({ sessionId, error })
            console.error('agent-session dead-generation settlement deferred', sessionId, error)
          })
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
  publish: (activity?: AgentSessionTurnActivity | null) => void
): Promise<void> {
  eventSink.bind({ journal, fence, publish })
  const barrier = await eventSink.drained()
  if (!barrier.ok) {
    throw barrier.error
  }
}
