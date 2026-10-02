import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { endProviderChild } from './structured-agent-session-provider-child'
import {
  releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit,
  type StructuredAgentSessionLeaseStore
} from './structured-agent-session-lease-release'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import {
  captureUnfinishedStructuredAgentSessionWork,
  MAX_UNEXPECTED_EXIT_REASON_CHARS,
  settleStructuredAgentSessionDeadGeneration,
  type DeadGenerationJournal,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionTurnVerdict } from './structured-agent-session-stale-turn-verdict'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { structuredAgentSessionOwedStopAwaitsExit } from './structured-agent-session-unproven-end'

type UnexpectedExitLifecycleEvent = StructuredAgentSessionEndedEvent & {
  cause: 'unexpected-exit'
}

export type StructuredAgentSessionUnexpectedExitSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'lastEndedChild' | 'owesProviderChildWindDown'
> & { journal: DeadGenerationJournal & Pick<AgentSessionJournal, 'cursor' | 'itemBody'> }

export type StructuredAgentSessionUnexpectedExitContext<
  TSession extends StructuredAgentSessionUnexpectedExitSession = StructuredAgentSessionHostSession
> = {
  store: StructuredAgentSessionLeaseStore
  sessions: Map<string, TSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishFence: (sessionId: string, session: TSession) => void
  publishStatus?: (sessionId: string) => void
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  logger: StructuredAgentSessionLogger
  /** Retries the stop owed for the session's child; for a caller inside its serialize. */
  finishOwedWindDown?: (sessionId: string) => Promise<boolean>
}

export async function settleUnexpectedStructuredAgentSessionExit<
  TSession extends StructuredAgentSessionUnexpectedExitSession
>(
  context: StructuredAgentSessionUnexpectedExitContext<TSession>,
  event: StructuredAgentSessionEndedEvent
): Promise<void> {
  if (event.cause !== 'unexpected-exit') {
    return
  }
  // Receipt of the exit is the one end time the host may record for a running turn.
  const observedAt = event.observedAt ?? context.now()
  return context.serialize(event.sessionId, async () => {
    const session = context.sessions.get(event.sessionId)
    const child = session?.child
    if (
      !session ||
      !child ||
      child.fence !== event.fence ||
      child.generation !== event.acquisitionGeneration
    ) {
      return
    }
    // The exit a stop that could not prove it was waiting on: that stop lands now, as its retry
    // would, keeping its own cause and settlement.
    const finishOwed = context.finishOwedWindDown
    if (finishOwed && structuredAgentSessionOwedStopAwaitsExit(session, child)) {
      await finishOwed(event.sessionId)
      return
    }
    const unexpectedEvent: UnexpectedExitLifecycleEvent = { ...event, cause: 'unexpected-exit' }
    // The host's own phase decides, so a provider that omits the flag still gets a start that
    // failed told as one: the row says so.
    const exitedDuringStartup =
      unexpectedEvent.startupUnproven === true || child.phase === 'starting'
    const endChild = (): void => {
      endProviderChild(session, {
        generation: child.generation,
        fence: child.fence,
        cause: 'exit',
        reason: unexpectedEvent.reason,
        ...(unexpectedEvent.failure ? { failure: unexpectedEvent.failure } : {}),
        duringStartup: exitedDuringStartup,
        // The adapter publishes an exit only once it saw the root go, first-hand or proven.
        rootGone: true
      })
      context.publishStatus?.(unexpectedEvent.sessionId)
    }
    const record = context.store.getRecord(unexpectedEvent.sessionId)
    if (!record || record.lease.handoffStage !== null) {
      // An acquisition or recovery already owns this lease's transition.
      endChild()
      return
    }

    const stableSettlementId = providerExitSettlementId(unexpectedEvent)
    const unfinishedWork = captureUnfinishedStructuredAgentSessionWork(session.journal)
    try {
      try {
        const barrier = await context.flushLifecycle(unexpectedEvent.sessionId)
        if (!barrier.ok) {
          logExitFailure(context, unexpectedEvent, 'exit-lifecycle-barrier', barrier.error)
        }
      } catch (error) {
        logExitFailure(context, unexpectedEvent, 'exit-lifecycle-barrier', error)
      }
      await retryUnexpectedExitSettlement({
        context,
        event: unexpectedEvent,
        journal: session.journal,
        fence: child.fence,
        stableSettlementId,
        verdict: { state: 'interrupted', completedAt: observedAt },
        exitedDuringStartup,
        failureTextContext: structuredAgentSessionFailureWordsContext(record, session.journal),
        // A failed start always says why: no response was running to carry the reason.
        showUnexpectedExitOutcome:
          exitedDuringStartup ||
          unfinishedStructuredAgentSessionWorkWasInterrupted(
            unfinishedWork,
            session.journal,
            observedAt
          )
      })
    } finally {
      // Provider exit was positively observed, so release the owner even when
      // terminal settlement could not be durably accepted.
      let released: Awaited<
        ReturnType<typeof releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit>
      > | null = null
      try {
        released = await releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit({
          store: context.store,
          sessionId: unexpectedEvent.sessionId,
          expectedFence: unexpectedEvent.fence,
          expectedAcquisitionGeneration: unexpectedEvent.acquisitionGeneration,
          acquisitionGeneration: child.generation,
          now: context.now(),
          exitObservedAt: observedAt,
          // Bare cause: whatever this settlement could not write is settled from it later (the
          // settle recording it queues, or the next open or acquire); `exit-observed` says the rest.
          exitReason: unexpectedEvent.reason.slice(0, MAX_UNEXPECTED_EXIT_REASON_CHARS)
        })
      } catch (error) {
        logExitFailure(context, unexpectedEvent, 'exit-owner-release', error)
      } finally {
        endChild()
        if (released) {
          context.publishFence(unexpectedEvent.sessionId, session)
        }
      }
    }
  })
}

async function retryUnexpectedExitSettlement(input: {
  context: Pick<StructuredAgentSessionUnexpectedExitContext, 'logger'>
  event: UnexpectedExitLifecycleEvent
  journal: DeadGenerationJournal
  fence: number
  stableSettlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  exitedDuringStartup: boolean
  failureTextContext: AgentSessionFailureWordsContext
  showUnexpectedExitOutcome?: boolean
}): Promise<void> {
  const settled = await settleStructuredAgentSessionDeadGeneration({
    journal: input.journal,
    sessionId: input.event.sessionId,
    fence: input.fence,
    settlementId: input.stableSettlementId,
    verdict: input.verdict,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement',
    showUnexpectedExitOutcome: input.showUnexpectedExitOutcome,
    ...(input.event.failure ? { exitFailure: input.event.failure } : {}),
    failureTextContext: input.failureTextContext,
    ...(input.exitedDuringStartup
      ? { exitedDuringStartup: { generation: input.event.acquisitionGeneration } }
      : {})
  })
  if (!settled.ok) {
    logExitFailure(input.context, input.event, 'exit-settlement', settled.error)
  }
}

function logExitFailure(
  context: Pick<StructuredAgentSessionUnexpectedExitContext, 'logger'>,
  event: UnexpectedExitLifecycleEvent,
  scope: string,
  error: unknown
): void {
  context.logger.warn('settling a provider exit did not finish', {
    scope,
    sessionId: event.sessionId,
    error
  })
}

function providerExitSettlementId(event: UnexpectedExitLifecycleEvent): string {
  return `provider-exit:${event.sessionId}:${event.fence}:${event.acquisitionGeneration}`
}
