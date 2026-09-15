import type { StructuredAgentSessionLifecycleEvent } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
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

type UnexpectedExitLifecycleEvent = StructuredAgentSessionLifecycleEvent & {
  cause: 'unexpected-exit'
}

export type StructuredAgentSessionRecoveryTicket = {
  sessionId: string
  releasedFence: number
  deadAcquisitionGeneration: string
  stableSettlementId: string
}

export type StructuredAgentSessionUnexpectedExitSession = {
  journal: DeadGenerationJournal
  hasProviderChild: boolean
  fence: number
  acquisitionGeneration: string | null
}

export type StructuredAgentSessionUnexpectedExitContext<
  TSession extends StructuredAgentSessionUnexpectedExitSession = StructuredAgentSessionHostSession
> = {
  store: StructuredAgentSessionLeaseStore
  sessions: Map<string, TSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishFence: (sessionId: string, session: TSession) => void
  publishStatus?: (sessionId: string) => void
  hasResumeCapableHolder: (sessionId: string) => boolean
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  onBarrierError?: (sessionId: string, error: unknown) => void
}

export async function settleUnexpectedStructuredAgentSessionExit<
  TSession extends StructuredAgentSessionUnexpectedExitSession
>(
  context: StructuredAgentSessionUnexpectedExitContext<TSession>,
  event: StructuredAgentSessionLifecycleEvent
): Promise<StructuredAgentSessionRecoveryTicket | null> {
  if (event.cause !== 'unexpected-exit') {
    return null
  }

  const unexpectedEvent = event as UnexpectedExitLifecycleEvent
  // Receipt of the exit is the one end time the host may record for a running turn.
  const observedAt = event.observedAt ?? context.now()

  return context.serialize(unexpectedEvent.sessionId, async () => {
    const session = context.sessions.get(unexpectedEvent.sessionId)

    if (
      !session?.hasProviderChild ||
      session.fence !== unexpectedEvent.fence ||
      session.acquisitionGeneration !== unexpectedEvent.acquisitionGeneration
    ) {
      return null
    }

    const record = context.store.getRecord(unexpectedEvent.sessionId)

    if (!record || record.lease.handoffStage !== null) {
      // The handoff coordinator owns an already-started transition.
      session.hasProviderChild = false
      context.publishStatus?.(unexpectedEvent.sessionId)

      return null
    }

    let settlementFailed = false
    const stableSettlementId = providerExitSettlementId(unexpectedEvent)
    const unfinishedWork = captureUnfinishedStructuredAgentSessionWork(session.journal)

    let released: Awaited<
      ReturnType<typeof releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit>
    > | null = null

    try {
      try {
        const barrier = await context.flushLifecycle(unexpectedEvent.sessionId)

        if (!barrier.ok) {
          context.onBarrierError?.(unexpectedEvent.sessionId, barrier.error)
        }
      } catch (error) {
        context.onBarrierError?.(unexpectedEvent.sessionId, error)
      }

      settlementFailed = !(await retryUnexpectedExitSettlement({
        context,
        event: unexpectedEvent,
        session,
        stableSettlementId,
        verdict: { state: 'interrupted', completedAt: observedAt },
        showUnexpectedExitOutcome: unfinishedStructuredAgentSessionWorkWasInterrupted(
          unfinishedWork,
          session.journal,
          observedAt
        )
      }))
    } finally {
      // Provider exit was positively observed, so release the owner even when
      // terminal settlement could not be durably accepted.
      try {
        released = await releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit({
          store: context.store,
          sessionId: unexpectedEvent.sessionId,
          expectedFence: unexpectedEvent.fence,
          expectedAcquisitionGeneration: unexpectedEvent.acquisitionGeneration,
          acquisitionGeneration: session.acquisitionGeneration,
          now: context.now(),
          exitObservedAt: observedAt,
          ...(settlementFailed
            ? {
                settlementRetry: {
                  settlementId: stableSettlementId,
                  // Bare cause: the retry renders it, and `exit-observed` already says the rest.
                  detail: unexpectedEvent.reason.slice(0, MAX_UNEXPECTED_EXIT_REASON_CHARS)
                }
              }
            : {})
        })
      } catch (error) {
        context.onBarrierError?.(unexpectedEvent.sessionId, error)
      } finally {
        session.hasProviderChild = false
        context.publishStatus?.(unexpectedEvent.sessionId)

        if (released) {
          session.fence = released.lease.runtimeFence
          context.publishFence(unexpectedEvent.sessionId, session)
        }
      }
    }

    if (settlementFailed || !released) {
      return null
    }

    if (!context.hasResumeCapableHolder(unexpectedEvent.sessionId)) {
      return null
    }

    return {
      sessionId: unexpectedEvent.sessionId,
      releasedFence: released.lease.runtimeFence,
      deadAcquisitionGeneration: unexpectedEvent.acquisitionGeneration,
      stableSettlementId
    }
  })
}

export function isStructuredAgentSessionRecoveryTicketCurrent(
  context: {
    store: Pick<StructuredAgentSessionLeaseStore, 'getRecord'>
    sessions: Map<
      string,
      Pick<
        StructuredAgentSessionUnexpectedExitSession,
        'hasProviderChild' | 'fence' | 'acquisitionGeneration'
      >
    >
    hasResumeCapableHolder: (sessionId: string) => boolean
  },
  ticket: StructuredAgentSessionRecoveryTicket
): boolean {
  const session = context.sessions.get(ticket.sessionId)
  const record = context.store.getRecord(ticket.sessionId)

  return (
    session?.hasProviderChild === false &&
    session.fence === ticket.releasedFence &&
    session.acquisitionGeneration === ticket.deadAcquisitionGeneration &&
    record?.lease.runtimeFence === ticket.releasedFence &&
    record.lease.claimStatus === 'released' &&
    record.lease.handoffStage === null &&
    context.hasResumeCapableHolder(ticket.sessionId)
  )
}

async function retryUnexpectedExitSettlement(input: {
  context: Pick<StructuredAgentSessionUnexpectedExitContext, 'onBarrierError'>
  event: UnexpectedExitLifecycleEvent
  session: Pick<StructuredAgentSessionUnexpectedExitSession, 'journal' | 'fence'>
  stableSettlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  showUnexpectedExitOutcome?: boolean
}): Promise<boolean> {
  return settleStructuredAgentSessionDeadGeneration({
    journal: input.session.journal,
    sessionId: input.event.sessionId,
    fence: input.session.fence,
    settlementId: input.stableSettlementId,
    verdict: input.verdict,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement',
    showUnexpectedExitOutcome: input.showUnexpectedExitOutcome,
    unexpectedExitReason: input.event.reason,
    onError: input.context.onBarrierError
  })
}

function providerExitSettlementId(event: UnexpectedExitLifecycleEvent): string {
  return `provider-exit:${event.sessionId}:${event.fence}:${event.acquisitionGeneration}`
}
