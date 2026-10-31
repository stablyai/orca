import {
  structuredAgentSessionEndedEventExit,
  type StructuredAgentSessionChildExitContext,
  type StructuredAgentSessionChildExitSession,
  type StructuredAgentSessionChildExit
} from './structured-agent-session-child-exit-contract'
export {
  structuredAgentSessionEndedEventExit,
  type StructuredAgentSessionChildExitContext,
  type StructuredAgentSessionChildExitSession,
  type StructuredAgentSessionGenerationEnded,
  type StructuredAgentSessionChildExit
} from './structured-agent-session-child-exit-contract'
import {
  personallyClosingStartup,
  reportStructuredAgentStartupFailure
} from './structured-agent-session-startup-report'
// First-hand writer death evidence ends the child record in finally. Attempt/report every bookkeeping step;
// expected changes presentation, never whether the dead child remains recorded.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { PROVIDER_EXIT_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { recordProviderChildEnd } from './structured-agent-session-provider-child'
import {
  releaseStoredStructuredAgentSessionOwnerAfterExit,
  upgradeStoredStructuredAgentSessionOwnerExitEvidence
} from './structured-agent-session-lease-release'
import {
  settleStructuredAgentSessionLeftovers,
  type StructuredAgentSessionExitSettlement
} from './structured-agent-session-leftover-settlement'
import {
  captureUnfinishedStructuredAgentSessionWork,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-unfinished-work'
import { evictStructuredAgentSession } from './structured-agent-session-eviction'

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
  const projection = exit.startupFailure ?? child.reportedStartupFailure
  if (projection && child.phase === 'starting') {
    reportStructuredAgentStartupFailure({
      ...context,
      child,
      sessionId,
      error: projection.error,
      projection
    })
  }
  const startupFailed = Boolean(
    projection && child.phase === 'starting' && !personallyClosingStartup(child)
  )
  const close = child.close
  const expected = exit.expected && close?.failure?.kind !== 'hostFault'
  const failure = close?.failure?.kind === 'hostFault' ? close.failure : exit.failure
  // Use the first death observation when settling the running turn.
  const observation = child.exitObservation?.()
  const observedAt = observation?.observedAt ?? exit.observedAt ?? context.now()
  // Host phase classifies startup failure even if adapters omit the flag.
  const exitedDuringStartup = child.phase === 'starting'
  if (child.phase === 'starting' || !expected) {
    context.abortBound?.(sessionId)
  }
  // Personal Stop cancels startup; host Stop fails it; preserve the close initiator.
  const startClose = expected && exitedDuringStartup ? close?.cause : undefined
  const startFailure = startupFailed
    ? projection?.failure
    : expected
      ? startClose === 'host-stop'
        ? (exit.failure ?? close?.failure ?? agentSessionFailureFact('hostStopped'))
        : undefined
      : failure
  // Unanswered startup sends never ran: cancel on Stop, preserve personal text on quit/close, fail host stops.
  const unrunRejection =
    startClose === 'user-stop' ? agentSessionFailureFact('cancelled') : undefined
  const unrunHold =
    expected &&
    !startupFailed &&
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
    cause: startupFailed ? 'exit' : expected ? (close?.cause ?? 'evict') : 'exit',
    reason: expected ? (close?.reason ?? null) : exit.reason,
    ...(startFailure ? { failure: startFailure } : {}),
    duringStartup: exitedDuringStartup,
    rootGone: true,
    ...(exit.deathEvidenceKind ? { deathEvidenceKind: exit.deathEvidenceKind } : {}),
    ...(expected && close ? { endedAt: close.requestedAt } : {})
  })
  context.generationEnded(sessionId)
  const endChild = (): void => {
    context.startupAttempts?.childEnded(sessionId, child)
    if (session.child === child) {
      session.child = null
    }
    context.publishStatus?.(sessionId)
  }
  const wakeQueuedDelivery = (): void => {
    if (
      !session.journal.submissions ||
      session.journal.submissions().some(isQueuedAgentJournalSubmission)
    ) {
      context.wakeDelivery?.(sessionId)
    }
  }
  const record = context.store.getRecord(sessionId)
  if (!record || record.lease.handoffStage !== null) {
    endChild()
    wakeQueuedDelivery()
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
    const unfinishedWork = captureUnfinishedStructuredAgentSessionWork(session.journal)
    // Quiet idle starts owe no failure row unless work was handed to them.
    let startFailed =
      exitedDuringStartup &&
      (startupFailed ||
        !expected ||
        (startClose === 'host-stop' && unfinishedWork.hadUnsettledSubmissions))
    // Fold Stop before fallback turn-end classification.
    await child.close?.recorded
    // A personal close can arrive while the final input/journal barriers are pending.
    if (personallyClosingStartup(child) && child.close) {
      startFailed = false
      recordProviderChildEnd(session, {
        generation: child.generation,
        fence: child.fence,
        cause: child.close.cause,
        reason: child.close.reason,
        duringStartup: exitedDuringStartup,
        rootGone: true,
        endedAt: child.close.requestedAt,
        ...(exit.deathEvidenceKind ? { deathEvidenceKind: exit.deathEvidenceKind } : {})
      })
    }
    const generation = child.generation ?? 'unknown'
    // Proven exit can refine earlier unverifiable rows.
    const watched = { ownerFence: child.fence, observedAt }
    settlement = {
      ownerFence: child.fence,
      settlementId: `${expected ? 'expected-close:' : PROVIDER_EXIT_ROW_PREFIX}${sessionId}:${child.fence}:${generation}`,
      pendingSubmissionReason: expected
        ? 'provider_closed_before_acknowledgement'
        : 'provider_exited_before_acknowledgement',
      // Provider-settled turns stand; fallback interruption applies journal Stop classification.
      verdict: { state: 'interrupted', completedAt: expected ? context.now() : observedAt },
      failureTextContext: structuredAgentSessionFailureWordsContext(record, session.journal),
      // Failed starts need explicit wording because no response can carry the reason.
      showUnexpectedExitOutcome:
        startFailed ||
        (!expected &&
          unfinishedStructuredAgentSessionWorkWasInterrupted(
            unfinishedWork,
            session.journal,
            observedAt,
            watched,
            observation?.heldSends ?? exit.heldSends
          )),
      ...(startFailure && !personallyClosingStartup(child) ? { exitFailure: startFailure } : {}),
      ...(startFailed && child.generation
        ? {
            exitedDuringStartup: {
              generation: child.generation,
              flightOwned: context.startFlights?.ownsChild(sessionId, child)
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
    try {
      await releaseStoredStructuredAgentSessionOwnerAfterExit({
        store: context.store,
        sessionId,
        expectedFence: child.fence,
        now: context.now(),
        exitObservedAt: observedAt,
        exitReason: exit.reason,
        ...(exit.deathEvidenceKind ? { deathEvidenceKind: exit.deathEvidenceKind } : {})
      })
      released = true
    } catch (error) {
      logExitFailure(context, sessionId, 'exit-owner-release', error)
    }
    if (context.route) {
      const { runtimeState, acknowledgeRelease } = context.route
      await evictStructuredAgentSession({
        sessionId,
        eventSink: runtimeState.eventSinkFor(sessionId),
        logger: context.logger,
        discardSink: () => runtimeState.discardEventSink(sessionId),
        acknowledgeRelease: () => acknowledgeRelease(sessionId)
      })
    }
    endChild()
    // Unexpected death rebaselines fences; requested close preserves outstanding Stop replies.
    // Always publish generation end and wake delivery, even when cleanup writes failed.
    context.generationEnded(sessionId, { restate: released && !expected })
    wakeQueuedDelivery()
  }
}

function logExitFailure(
  context: Pick<StructuredAgentSessionChildExitContext, 'logger'>,
  sessionId: string,
  scope: string,
  error: unknown
): void {
  context.logger.warn('settling a provider exit did not finish', { scope, sessionId, error })
}
