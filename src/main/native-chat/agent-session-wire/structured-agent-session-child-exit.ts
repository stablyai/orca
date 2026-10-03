// The one handler that ends a provider child's record, whether its exit was expected (a close this
// host asked for) or not (the child died on its own). The exit was seen or proven first-hand, so
// every step after it is bookkeeping: each is attempted and reported, none keeps the child on
// record, and the record ends in `finally`. `expected` changes only what the chat is told.

import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { endProviderChild } from './structured-agent-session-provider-child'
import {
  releaseStoredStructuredAgentSessionOwnerAfterExit,
  type StructuredAgentSessionLeaseStore
} from './structured-agent-session-lease-release'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStructuredAgentSessionDeadGeneration,
  type DeadGenerationJournal,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { evictStructuredAgentSession } from './structured-agent-session-eviction'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'

/** How the child's root went: the close this host asked for, or a death of its own. */
export type StructuredAgentSessionChildExit = {
  expected: boolean
  /** Log text only; the chat's words come from `failure`. */
  reason: string
  failure?: SubmissionRejectionFact
  /** Host receipt of the exit: the end time of a turn it interrupted. */
  observedAt?: number
  startupUnproven?: true
}

export type StructuredAgentSessionChildExitSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'lastEndedChild'
> & { journal: DeadGenerationJournal & Pick<AgentSessionJournal, 'cursor' | 'itemBody'> }

export type StructuredAgentSessionChildExitContext<
  TSession extends StructuredAgentSessionChildExitSession = StructuredAgentSessionHostSession
> = {
  store: StructuredAgentSessionLeaseStore
  sessions: Map<string, TSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishFence: (sessionId: string, session: TSession) => void
  publishStatus?: (sessionId: string) => void
  /** The delivery loop hands over whatever is queued once the child is off the record. */
  wakeDelivery?: (sessionId: string) => void
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  logger: StructuredAgentSessionLogger
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
      ...(event.startupUnproven ? { startupUnproven: event.startupUnproven } : {})
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
  const endChild = (): void => {
    endProviderChild(session, {
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
    context.publishStatus?.(sessionId)
  }
  const record = context.store.getRecord(sessionId)
  if (!record || record.lease.handoffStage !== null) {
    // An acquisition or recovery already owns this lease's transition.
    endChild()
    context.wakeDelivery?.(sessionId)
    return
  }
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
    const unfinishedWork = captureUnfinishedStructuredAgentSessionWork(session.journal)
    // Folded before the fallback's end is built, so the end reads it (`turnEndAfterStop`).
    await close?.recorded
    const generation = child.generation ?? 'unknown'
    const settled = await settleStructuredAgentSessionDeadGeneration({
      journal: session.journal,
      sessionId,
      fence: child.fence,
      settlementId: `${expected ? 'expected-close' : 'provider-exit'}:${sessionId}:${child.fence}:${generation}`,
      pendingSubmissionReason: expected
        ? 'provider_closed_before_acknowledgement'
        : 'provider_exited_before_acknowledgement',
      // Only a turn no adapter settled. Whether a close ended a person's turn is the Stop event's to
      // say (`turnEndAfterStop`); a death of its own interrupted it.
      verdict: { state: 'interrupted', completedAt: expected ? context.now() : observedAt },
      failureTextContext: structuredAgentSessionFailureWordsContext(record, session.journal),
      // A failed start always says why: no response was running to carry the reason.
      showUnexpectedExitOutcome:
        !expected &&
        (exitedDuringStartup ||
          unfinishedStructuredAgentSessionWorkWasInterrupted(
            unfinishedWork,
            session.journal,
            observedAt
          )),
      ...(!expected && exit.failure ? { exitFailure: exit.failure } : {}),
      ...(!expected && exitedDuringStartup && child.generation
        ? { exitedDuringStartup: { generation: child.generation } }
        : {})
    })
    if (!settled.ok) {
      logExitFailure(context, sessionId, 'exit-settlement', settled.error)
    }
  } finally {
    // The root's exit was observed, so the owner is released even when terminal settlement could
    // not be durably accepted. Bare cause: whatever this settlement could not write is settled from
    // it later (the settle recording it queues, or the next open or acquire).
    let released = false
    try {
      await releaseStoredStructuredAgentSessionOwnerAfterExit({
        store: context.store,
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
    // reader holds, as a client resends a message when its fence moves.
    if (released && !expected) {
      context.publishFence(sessionId, session)
    }
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
