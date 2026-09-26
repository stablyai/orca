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

type UnexpectedExitLifecycleEvent = StructuredAgentSessionEndedEvent & {
  cause: 'unexpected-exit'
}

export type StructuredAgentSessionRecoveryTicket = {
  sessionId: string
  releasedFence: number
  deadAcquisitionGeneration: string
  stableSettlementId: string
}

export type StructuredAgentSessionUnexpectedExitSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'lastEndedChild'
> & { journal: DeadGenerationJournal & Pick<AgentSessionJournal, 'cursor'> }

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
  event: StructuredAgentSessionEndedEvent
): Promise<StructuredAgentSessionRecoveryTicket | null> {
  if (event.cause !== 'unexpected-exit') {
    return null
  }
  const unexpectedEvent = event as UnexpectedExitLifecycleEvent
  // Receipt of the exit is the one end time the host may record for a running turn.
  const observedAt = event.observedAt ?? context.now()
  return context.serialize(unexpectedEvent.sessionId, async () => {
    const session = context.sessions.get(unexpectedEvent.sessionId)
    const child = session?.child
    if (
      !session ||
      !child ||
      child.fence !== unexpectedEvent.fence ||
      child.generation !== unexpectedEvent.acquisitionGeneration
    ) {
      return null
    }
    // The host's own phase decides, so a provider that omits the flag still gets a start that
    // failed told as one: the row says so, and nothing resumes into the same failure.
    const exitedDuringStartup =
      unexpectedEvent.startupUnproven === true || child.phase === 'starting'
    const endChild = (): void => {
      endProviderChild(session, {
        generation: child.generation,
        fence: child.fence,
        cause: 'exit',
        reason: unexpectedEvent.reason,
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
        journal: session.journal,
        fence: child.fence,
        stableSettlementId,
        verdict: { state: 'interrupted', completedAt: observedAt },
        exitedDuringStartup,
        // A failed start always says why: no response was running to carry the reason.
        showUnexpectedExitOutcome:
          exitedDuringStartup ||
          unfinishedStructuredAgentSessionWorkWasInterrupted(
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
          acquisitionGeneration: child.generation,
          now: context.now(),
          exitObservedAt: observedAt,
          // Bare cause: whatever this settlement could not write is settled from it later, by the
          // next acquire or read restore, and `exit-observed` already says the rest.
          exitReason: unexpectedEvent.reason.slice(0, MAX_UNEXPECTED_EXIT_REASON_CHARS)
        })
      } catch (error) {
        context.onBarrierError?.(unexpectedEvent.sessionId, error)
      } finally {
        endChild()
        if (released) {
          context.publishFence(unexpectedEvent.sessionId, session)
        }
      }
    }
    if (settlementFailed || !released) {
      return null
    }
    // Resuming a start that failed would respawn into the same failure; the next send retries.
    if (exitedDuringStartup || !context.hasResumeCapableHolder(unexpectedEvent.sessionId)) {
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
      Pick<StructuredAgentSessionUnexpectedExitSession, 'child' | 'lastEndedChild'>
    >
    hasResumeCapableHolder: (sessionId: string) => boolean
  },
  ticket: StructuredAgentSessionRecoveryTicket
): boolean {
  const session = context.sessions.get(ticket.sessionId)
  const record = context.store.getRecord(ticket.sessionId)
  return (
    session !== undefined &&
    session.child === null &&
    session.lastEndedChild?.generation === ticket.deadAcquisitionGeneration &&
    record?.lease.runtimeFence === ticket.releasedFence &&
    record.lease.claimStatus === 'released' &&
    record.lease.handoffStage === null &&
    context.hasResumeCapableHolder(ticket.sessionId)
  )
}

async function retryUnexpectedExitSettlement(input: {
  context: Pick<StructuredAgentSessionUnexpectedExitContext, 'onBarrierError'>
  event: UnexpectedExitLifecycleEvent
  journal: DeadGenerationJournal
  fence: number
  stableSettlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  exitedDuringStartup: boolean
  showUnexpectedExitOutcome?: boolean
}): Promise<boolean> {
  return settleStructuredAgentSessionDeadGeneration({
    journal: input.journal,
    sessionId: input.event.sessionId,
    fence: input.fence,
    settlementId: input.stableSettlementId,
    verdict: input.verdict,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement',
    showUnexpectedExitOutcome: input.showUnexpectedExitOutcome,
    unexpectedExitReason: input.event.reason,
    ...(input.exitedDuringStartup
      ? { exitedDuringStartup: { generation: input.event.acquisitionGeneration } }
      : {}),
    onError: input.context.onBarrierError
  })
}

function providerExitSettlementId(event: UnexpectedExitLifecycleEvent): string {
  return `provider-exit:${event.sessionId}:${event.fence}:${event.acquisitionGeneration}`
}
