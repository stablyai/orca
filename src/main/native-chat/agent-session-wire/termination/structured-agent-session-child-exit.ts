// First-hand writer death evidence ends the child record in finally. Attempt/report every bookkeeping step;
// expected changes presentation, never whether the dead child remains recorded.

import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { PROVIDER_EXIT_ROW_PREFIX } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-stop-row-identity'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { structuredAgentSessionFailureWordsContext } from '../operations/structured-agent-session-send-preparation'
import type { StructuredAgentSessionEndedEvent } from '../providers/structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from '../host/structured-agent-session-host-types'
import { recordProviderChildEnd } from '../host/structured-agent-session-provider-child'
import {
  releaseExitedStructuredAgentSessionOwner,
  upgradeStoredStructuredAgentSessionOwnerExitEvidence,
  type StructuredAgentSessionLeaseStore
} from '../host/structured-agent-session-lease-release'
import type { StructuredAgentSessionSinkBarrier } from '../journal-ingress/structured-agent-session-event-sink'
import {
  settleStructuredAgentSessionLeftovers,
  type StructuredAgentSessionExitSettlement,
  type StructuredAgentSessionLeftoverStore,
  type StructuredAgentSessionLeftoverSettlementInput
} from './structured-agent-session-leftover-settlement'
import {
  captureUnfinishedStructuredAgentSessionWork,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-unfinished-work'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionChildExit } from './structured-agent-session-child-exit-record'
import { structuredAgentSessionEndedEventExit } from './structured-agent-session-child-exit-record'
import { logExitFailure, logProviderChildExit } from './structured-agent-session-provider-exit-log'
import type { StructuredAgentSessionHostRuntimeState } from '../host/structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionStartFlights } from '../startup/structured-agent-session-start-flight'
import type { StructuredAgentSessionStartupAttempts } from '../startup/structured-agent-session-startup-attempt'

export type StructuredAgentSessionChildExitSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'lastEndedChild' | 'workChanged'
> & { journal: StructuredAgentSessionLeftoverSettlementInput['journal'] }

export type StructuredAgentSessionGenerationEnded = (
  sessionId: string,
  options?: { restate?: boolean }
) => void

export type StructuredAgentSessionChildExitContext<
  TSession extends StructuredAgentSessionChildExitSession = StructuredAgentSessionHostSession
> = {
  store: StructuredAgentSessionLeaseStore & StructuredAgentSessionLeftoverStore
  sessions: Map<string, TSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishStatus?: (sessionId: string) => void
  /** Re-derive current work and wake queue without requiring a row; restate rebaselines moved fences. */
  generationEnded: StructuredAgentSessionGenerationEnded
  wakeDelivery?: (sessionId: string) => void
  startupAttempts?: Pick<StructuredAgentSessionStartupAttempts, 'childEnded' | 'ownsOpen'>
  /** Retain exits between background-start spawn and publication. */
  startFlights?: Pick<StructuredAgentSessionStartFlights, 'deferExit' | 'ownsChild'>
  abortBound?: (sessionId: string) => void
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  logger: StructuredAgentSessionLogger
  /** Failed-start handed-over sends settle like queued work because none ran. */
  holdUnrunSends?: (
    sessionId: string,
    fence: number,
    cause: 'chatClosed' | 'hostRestarted'
  ) => Promise<void>
  /** Release sink/route now; absent defers cleanup to next attach. */
  route?: {
    runtimeState: Pick<StructuredAgentSessionHostRuntimeState, 'eventSinkFor' | 'discardEventSink'>
    acknowledgeRelease: (sessionId: string) => Promise<void> | void
  }
}

export function settleStructuredAgentSessionChildExit<
  TSession extends StructuredAgentSessionChildExitSession
>(
  context: StructuredAgentSessionChildExitContext<TSession>,
  event: StructuredAgentSessionEndedEvent
): Promise<void> {
  return context.serialize(event.sessionId, async () => {
    const child = context.sessions.get(event.sessionId)?.child
    // Startup publication must apply exits received before child indexing.
    if (!child && context.startFlights?.deferExit(event)) {
      return
    }
    if (!child || child.fence !== event.fence || child.generation !== event.acquisitionGeneration) {
      await upgradeStoredStructuredAgentSessionOwnerExitEvidence(
        context.store,
        event,
        context.now()
      )
      return
    }
    await endExitedStructuredAgentSessionChildUnderSerialize(
      context,
      event.sessionId,
      child,
      structuredAgentSessionEndedEventExit(event)
    )
  })
}

export async function endExitedStructuredAgentSessionChildUnderSerialize<
  TSession extends StructuredAgentSessionChildExitSession
>(
  context: StructuredAgentSessionChildExitContext<TSession>,
  sessionId: string,
  child: StructuredAgentSessionProviderChild,
  exit: StructuredAgentSessionChildExit
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (!session || session.child !== child) {
    return
  }
  const close = child.close
  const failedClose =
    close?.failure?.kind === 'hostFault' || close?.failure?.kind === 'pluginInputRequired'
  const stoppedPlugin = exit.failure?.kind === 'pluginInputRequired' && close?.cause === 'user-stop'
  const expected = (exit.expected || stoppedPlugin) && !failedClose
  const failure = failedClose ? close?.failure : exit.failure
  // Use the first death observation when settling the running turn.
  const observation = child.exitObservation?.()
  const observedAt = observation?.observedAt ?? exit.observedAt ?? context.now()
  // Host phase classifies startup failure even if adapters omit the flag. A starting child's
  // exit cancels nothing: the start's owner gives its outcome from the adapter's answer.
  const exitedDuringStartup = child.phase === 'starting'
  if (!exitedDuringStartup && !expected) {
    context.abortBound?.(sessionId)
  }
  // Personal Stop cancels startup; host Stop fails it; preserve the close initiator.
  const startClose = expected && exitedDuringStartup ? close?.cause : undefined
  const startFailure = expected
    ? startClose === 'host-stop'
      ? (exit.failure ?? close?.failure ?? agentSessionFailureFact('hostStopped'))
      : undefined
    : failure
  // Unanswered startup sends never ran: cancel on Stop, preserve personal text on quit/close, fail host stops.
  const unrunRejection =
    startClose === 'user-stop' ? agentSessionFailureFact('cancelled') : undefined
  const unrunHold =
    expected &&
    exit.startupUnanswered &&
    close?.cause !== 'host-stop' &&
    close?.cause !== 'user-stop' &&
    close?.cause !== 'context-clear'
      ? close?.quit
        ? ('hostRestarted' as const)
        : ('chatClosed' as const)
      : undefined
  // Publish death before drain/settlement so no frame shows working or answerable prompts; keep the sink to drain tail.
  recordProviderChildEnd(session, {
    generation: child.generation,
    fence: child.fence,
    cause: expected ? (close?.cause ?? 'evict') : 'exit',
    reason: expected ? (close?.reason ?? null) : exit.reason,
    ...(startFailure ? { failure: startFailure } : {}),
    duringStartup: exitedDuringStartup,
    rootGone: true,
    ...(exit.deathEvidenceKind ? { deathEvidenceKind: exit.deathEvidenceKind } : {}),
    ...(expected && close ? { endedAt: close.requestedAt } : {})
  })
  logProviderChildExit(context.logger, sessionId, child, {
    expected,
    failure,
    exit,
    duringStartup: exitedDuringStartup
  })
  context.generationEnded(sessionId)
  const endChild = (): void => {
    context.startupAttempts?.childEnded(sessionId, child, {
      byOrca: expected || !!close,
      ...(close?.failure ? { failure: close.failure, reason: close.reason ?? exit.reason } : {})
    })
    if (session.child === child) {
      session.child = null
      session.workChanged?.()
    }
    context.publishStatus?.(sessionId)
  }
  const wakeQueuedDelivery = async (): Promise<void> => {
    if (
      (await session.journal.reads.input({ kind: 'recoverable-submissions' })).submissions.some(
        isQueuedAgentJournalSubmission
      )
    ) {
      context.wakeDelivery?.(sessionId)
    }
  }
  const record = context.store.getRecord(sessionId)
  if (!record || record.lease.handoffStage !== null) {
    endChild()
    await wakeQueuedDelivery()
    return
  }
  let settlement: StructuredAgentSessionExitSettlement | null = null
  try {
    // Drain the child’s tail before deriving dead-generation settlement.
    try {
      const barrier = await context.flushLifecycle(sessionId)
      if (!barrier.ok) {
        logExitFailure(context, sessionId, 'exit-lifecycle-barrier', barrier.error)
      }
    } catch (error) {
      logExitFailure(context, sessionId, 'exit-lifecycle-barrier', error)
    }
    if (unrunHold && context.holdUnrunSends) {
      await context
        .holdUnrunSends(sessionId, child.fence, unrunHold)
        .catch((error: unknown) => logExitFailure(context, sessionId, 'exit-unrun-hold', error))
    }
    const before = await session.journal.reads.generation()
    const beforeFences = new Map(before.itemFences)
    const unfinishedWork = captureUnfinishedStructuredAgentSessionWork({
      handoverJournal: session.journal,
      snapshot: () => before,
      submissions: () => before.submissions,
      itemFence: (id) => beforeFences.get(id)
    })
    // Quiet idle starts owe no failure row unless work was handed to them.
    const startFailed =
      exitedDuringStartup &&
      (!expected || (startClose === 'host-stop' && unfinishedWork.hadUnsettledSubmissions))
    // Fold Stop before fallback turn-end classification.
    await close?.recorded
    // Proven exit can refine earlier unverifiable rows.
    const watched = { ownerFence: child.fence, observedAt }
    const after = await session.journal.reads.generation({
      itemIds: unfinishedWork.items.map((item) => item.itemId),
      exitScope: { completedAt: observedAt, ownerFence: child.fence }
    })
    const afterFences = new Map(after.itemFences)
    const afterBodies = new Map(after.items.map((item) => [item.itemId, item.body]))
    const afterSends = new Map(after.submissions.map((send) => [send.clientMessageId, send]))
    settlement = {
      ownerFence: child.fence,
      settlementId: `${expected ? 'expected-close:' : PROVIDER_EXIT_ROW_PREFIX}${sessionId}:${child.fence}:${child.generation ?? 'unknown'}`,
      pendingSubmissionReason: expected
        ? 'provider_closed_before_acknowledgement'
        : 'provider_exited_before_acknowledgement',
      // Provider-settled turns stand; fallback interruption applies journal Stop classification.
      verdict: { state: 'interrupted', completedAt: expected ? context.now() : observedAt },
      failureTextContext: structuredAgentSessionFailureWordsContext(record, {
        submissions: () => after.submissions,
        itemBody: (id) => afterBodies.get(id) ?? null
      }),
      // Failed starts need explicit wording because no response can carry the reason.
      showUnexpectedExitOutcome:
        startFailed ||
        (!expected &&
          unfinishedStructuredAgentSessionWorkWasInterrupted(
            unfinishedWork,
            {
              handoverJournal: session.journal,
              snapshot: () => after,
              submissions: () => after.submissions,
              submission: (id) => afterSends.get(id),
              itemFence: (id) => afterFences.get(id)
            },
            observedAt,
            watched,
            observation?.heldSends ?? exit.heldSends
          )),
      ...(startFailure ? { exitFailure: startFailure } : {}),
      ...(startFailed && child.generation
        ? {
            exitedDuringStartup: {
              generation: child.generation,
              owned:
                context.startFlights?.ownsChild(sessionId, child) ||
                context.startupAttempts?.ownsOpen(sessionId, child)
            }
          }
        : {}),
      exit: watched,
      ...(unrunRejection ? { unrunRejection } : {})
    }
  } finally {
    // Settle at the child’s own fence, then release on proven root exit even if writes fail; next open retries recovery.
    let released = false
    if (settlement) {
      const settled = await settleStructuredAgentSessionLeftovers({
        store: context.store,
        sessionId,
        journal: session.journal,
        exit: settlement,
        ended: { fence: child.fence, rootGone: true }
      })
      if (!settled.ok) {
        logExitFailure(context, sessionId, 'exit-settlement', settled.error)
      }
    }
    released = await releaseExitedStructuredAgentSessionOwner(
      context,
      sessionId,
      child.fence,
      exit,
      observedAt
    )
    endChild()
    // Unexpected death rebaselines fences; requested close preserves outstanding Stop replies.
    // Always publish generation end and wake delivery, even when cleanup writes failed.
    context.generationEnded(sessionId, { restate: released && !expected })
    await wakeQueuedDelivery()
  }
}
