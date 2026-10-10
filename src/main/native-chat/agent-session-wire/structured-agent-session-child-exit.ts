// The one handler that ends a provider child's record, whether its exit was expected (a close this
// host asked for) or not (the child died on its own). The exit was seen or proven first-hand, so
// every step after it is bookkeeping: each is attempted and reported, none keeps the child on
// record, and the record ends in `finally`. `expected` changes only what the chat is told.

import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { PROVIDER_EXIT_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { recordProviderChildEnd } from './structured-agent-session-provider-child'
import {
  backgroundLeaseWrites,
  backgroundSettlementWrites
} from './structured-agent-session-background-writes'
import {
  releaseStoredStructuredAgentSessionOwnerAfterExit,
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
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'

/** How the child's root went: the close this host asked for, or a death of its own. */
export type StructuredAgentSessionChildExit = {
  expected: boolean
  /** Log text only; the chat's words come from `failure`. */
  reason: string
  failure?: SubmissionRejectionFact
  /** Host receipt of the exit: the end time of a turn it interrupted. */
  observedAt?: number
  startupUnproven?: true
  startupUnanswered?: true
}

export type StructuredAgentSessionChildExitSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'lastEndedChild'
> & { journal: DeadGenerationJournal & StaleStructuredAgentSessionStateJournal }

/** The host retry's signal (`StructuredAgentSessionRetry.signal`): the one edge every way a
 *  generation ends goes through. `exit`: the exit's own settlement, owed when
 *  it did not land. */
export type StructuredAgentSessionGenerationEnded = (
  sessionId: string,
  options?: { restate?: boolean; exit?: StructuredAgentSessionExitSettlement }
) => void

export type StructuredAgentSessionChildExitContext<
  TSession extends StructuredAgentSessionChildExitSession = StructuredAgentSessionHostSession
> = {
  store: StructuredAgentSessionLeaseStore & StructuredAgentSessionLeftoverStore
  sessions: Map<string, TSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishStatus?: (sessionId: string) => void
  /** A generation ended: every reader re-derives current work, the queued-card drain is
   *  scheduled with no journal write needed, and the host's retry settles what is owed. `restate`: each chat re-baselines at the moved fence. */
  generationEnded: StructuredAgentSessionGenerationEnded
  /** The delivery loop hands over whatever is queued once the child is off the record. */
  wakeDelivery?: (sessionId: string) => void
  /** An ended child's start, if still open, has nothing left to time. */
  startupAttempts?: Pick<StructuredAgentSessionStartupAttempts, 'childEnded'>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  logger: StructuredAgentSessionLogger
  /** Settles what a child that ended before it answered its start was handed and never echoed, as
   *  the chat settles a queued send for the same end (`holdUnsentSends`). */
  holdUnrunSends?: (
    sessionId: string,
    fence: number,
    cause: 'chatClosed' | 'hostRestarted'
  ) => Promise<void>
  /** Lets the child's sink and the adapter's route for it go; absent leaves both to the next attach. */
  route?: {
    runtimeState: Pick<StructuredAgentSessionHostRuntimeState, 'eventSinkFor' | 'discardEventSink'>
    acknowledgeRelease: (sessionId: string) => Promise<void> | void
  }
}

/** An adapter's report of a child's exit, for the child still on record with its identity. */
export function settleStructuredAgentSessionChildExit<
  TSession extends StructuredAgentSessionChildExitSession
>(
  context: StructuredAgentSessionChildExitContext<TSession>,
  event: StructuredAgentSessionEndedEvent
): Promise<void> {
  return context.serialize(event.sessionId, async () => {
    const child = context.sessions.get(event.sessionId)?.child
    if (!child || child.fence !== event.fence || child.generation !== event.acquisitionGeneration) {
      return
    }
    await endExitedStructuredAgentSessionChildUnderSerialize(context, event.sessionId, child, {
      expected: event.cause === 'requested-close',
      reason: event.reason,
      ...(event.failure ? { failure: event.failure } : {}),
      ...(event.observedAt === undefined ? {} : { observedAt: event.observedAt }),
      ...(event.startupUnproven ? { startupUnproven: event.startupUnproven } : {}),
      ...(event.startupUnanswered ? { startupUnanswered: event.startupUnanswered } : {})
    })
  })
}

/** Ends the record of a child whose exit this host saw or proved; a no-op once it has left. */
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
  const { expected } = exit
  const close = child.close
  // Receipt of the exit is the one end time the host may record for a running turn.
  const observedAt = exit.observedAt ?? context.now()
  // The host's own phase decides, so a provider that omits the flag still gets a start that
  // failed told as one: the row says so.
  const exitedDuringStartup = exit.startupUnproven === true || child.phase === 'starting'
  // A close during startup settles what the child was handed, never echoed, by who asked: a
  // person's Stop stops it; the host's stop fails the start, as an exit of its own would.
  const startClose = expected && exitedDuringStartup ? close?.cause : undefined
  const startFailure = expected
    ? startClose === 'host-stop'
      ? agentSessionFailureFact('hostStopped')
      : undefined
    : exit.failure
  // A send the child was handed and never echoed cannot have run when a person's Stop ended its
  // start, or any close ended it before it answered its start: settled as the chat settles a queued
  // send for the same end. A Stop withdraws it as cancelled; a quit or close keeps a person's
  // message as a held card. A host stop fails the start (`startFailure`).
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
  // Death first: before the tail, the settlement or the release writes anything, every reader
  // projects this generation as ended, so no frame they publish reads it Working and no prompt it
  // raised is answerable. The child stays on record (its sink drains the tail) until `endChild`.
  recordProviderChildEnd(session, {
    generation: child.generation,
    fence: child.fence,
    // A close keeps the cause of the stop that asked for it, and ends where it was asked.
    cause: expected ? (close?.cause ?? 'evict') : 'exit',
    reason: expected ? (close?.reason ?? null) : exit.reason,
    ...(!expected && exit.failure ? { failure: exit.failure } : {}),
    duringStartup: exitedDuringStartup,
    // The adapter publishes an exit only once it saw the root go, first-hand or proven.
    rootGone: true,
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
  const record = context.store.getRecord(sessionId)
  if (!record || record.lease.handoffStage !== null) {
    // An acquisition or recovery already owns this lease's transition.
    endChild()
    context.wakeDelivery?.(sessionId)
    return
  }
  let settlement: StructuredAgentSessionExitSettlement | null = null
  try {
    // The exited child's own writes land first: its dead generation is settled from all of them.
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
    // The host's stop fails only a start something was handed to; an idle one goes quietly.
    const startFailed =
      exitedDuringStartup &&
      (!expected || (startClose === 'host-stop' && unfinishedWork.hadUnsettledSubmissions))
    // Folded before the fallback's end is built, so the end reads it (`turnEndAfterStop`).
    await close?.recorded
    const generation = child.generation ?? 'unknown'
    // The exit proves this child gone, as the record's death evidence says once released: what it
    // left `unverifiable` is revised now.
    const watched = { ownerFence: child.fence, observedAt }
    settlement = {
      ownerFence: child.fence,
      settlementId: `${expected ? 'expected-close:' : PROVIDER_EXIT_ROW_PREFIX}${sessionId}:${child.fence}:${generation}`,
      pendingSubmissionReason: expected
        ? 'provider_closed_before_acknowledgement'
        : 'provider_exited_before_acknowledgement',
      // Only a turn no adapter settled. Whether a close ended a person's turn is the Stop event's to
      // say (`turnEndAfterStop`); a death of its own interrupted it.
      verdict: { state: 'interrupted', completedAt: expected ? context.now() : observedAt },
      failureTextContext: structuredAgentSessionFailureWordsContext(record, session.journal),
      // A failed start always says why: no response was running to carry the reason.
      showUnexpectedExitOutcome:
        startFailed ||
        (!expected &&
          unfinishedStructuredAgentSessionWorkWasInterrupted(
            unfinishedWork,
            session.journal,
            observedAt,
            watched
          )),
      ...(startFailure ? { exitFailure: startFailure } : {}),
      ...(startFailed && child.generation
        ? { exitedDuringStartup: { generation: child.generation } }
        : {}),
      exit: watched,
      ...(unrunRejection ? { unrunRejection } : {})
    }
  } finally {
    // What the exited child left is settled first, at its own fence, as its own closing tail lands:
    // a row its closed sink still delivers lands too, and wakes the retry to settle it once the
    // release below moves the fence. Both are bookkeeping (`structured-agent-session-background-
    // writes.ts`): another connection's lock fails them at once, and what did not commit stays owed
    // to the retry, the settlement as the exit's debt and the release as its repair.
    let released = false
    let owed: StructuredAgentSessionExitSettlement | null = null
    if (settlement) {
      const settled = await settleStructuredAgentSessionLeftovers({
        store: context.store,
        sessionId,
        journal: session.journal,
        writes: backgroundSettlementWrites(session.journal),
        exit: settlement,
        // Ended whether or not the release lands: the host saw the root go.
        ended: { fence: child.fence, rootGone: true }
      })
      if (!settled.ok) {
        owed = settlement
        logExitFailure(context, sessionId, 'exit-settlement', settled.error)
      }
    }
    try {
      await releaseStoredStructuredAgentSessionOwnerAfterExit({
        store: context.store,
        writes: backgroundLeaseWrites(context.store),
        sessionId,
        expectedFence: child.fence,
        now: context.now(),
        exitObservedAt: observedAt,
        exitReason: exit.reason
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
    // A reader re-baselines on a death of the child's own; a close Orca asked for moves no fence a
    // reader holds, as a client resends a message when its fence moves, and discards a reply (the
    // Stop's own) issued at the fence before. Either way every reader learns the generation ended
    // and the queued-card drain runs, whether or not the release or the settlement was written.
    context.generationEnded(sessionId, {
      restate: released && !expected,
      ...(owed ? { exit: owed } : {})
    })
    context.wakeDelivery?.(sessionId)
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
