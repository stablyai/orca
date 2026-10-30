// First-hand writer death evidence ends the child record in finally. Attempt/report every bookkeeping step;
// expected changes presentation, never whether the dead child remains recorded.

import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { PROVIDER_EXIT_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { recordProviderChildEnd } from './structured-agent-session-provider-child'
import {
  releaseStoredStructuredAgentSessionOwnerAfterExit,
  upgradeStoredStructuredAgentSessionOwnerExitEvidence,
  type StructuredAgentSessionLeaseStore
} from './structured-agent-session-lease-release'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import {
  settleStructuredAgentSessionLeftovers,
  type StructuredAgentSessionExitSettlement,
  type StructuredAgentSessionLeftoverStore
} from './structured-agent-session-leftover-settlement'
import type { StaleStructuredAgentSessionStateJournal } from './structured-agent-session-stale-state-settlement'
import {
  captureUnfinishedStructuredAgentSessionWork,
  type DeadGenerationJournal,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-unfinished-work'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { evictStructuredAgentSession } from './structured-agent-session-eviction'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'

export type StructuredAgentSessionChildExit = {
  deathEvidenceKind?: 'kill-delivered'
  heldSends?: ReadonlySet<string>
  expected: boolean
  /** Log only; failure supplies user-facing wording. */
  reason: string
  failure?: SubmissionRejectionFact
  observedAt?: number
  startupUnanswered?: true
}

export type StructuredAgentSessionChildExitSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'lastEndedChild'
> & { journal: DeadGenerationJournal & StaleStructuredAgentSessionStateJournal }

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
  startupAttempts?: Pick<StructuredAgentSessionStartupAttempts, 'childEnded'>
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

export function structuredAgentSessionEndedEventExit(
  event: StructuredAgentSessionEndedEvent
): StructuredAgentSessionChildExit {
  return {
    expected: event.cause === 'requested-close',
    ...(event.deathEvidenceKind ? { deathEvidenceKind: event.deathEvidenceKind } : {}),
    reason: event.reason,
    ...(event.failure ? { failure: event.failure } : {}),
    ...(event.observedAt === undefined ? {} : { observedAt: event.observedAt }),
    ...(event.startupUnanswered ? { startupUnanswered: event.startupUnanswered } : {})
  }
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
    const startFailed =
      exitedDuringStartup &&
      (!expected || (startClose === 'host-stop' && unfinishedWork.hadUnsettledSubmissions))
    // Fold Stop before fallback turn-end classification.
    await close?.recorded
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
      ...(startFailure ? { exitFailure: startFailure } : {}),
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
