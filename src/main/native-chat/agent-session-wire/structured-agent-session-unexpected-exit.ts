import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { partitionJournalLifecycleMutations } from '../agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import {
  boundJournalStatusText,
  cancelledJournalPromptBody
} from '../agent-session-journal/journal-prompt-body-bounds'
import type { StructuredAgentSessionLifecycleEvent } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit } from './structured-agent-session-lease-release'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'

type UnexpectedExitLifecycleEvent = StructuredAgentSessionLifecycleEvent & {
  cause: 'unexpected-exit'
}

export type StructuredAgentSessionRecoveryTicket = {
  sessionId: string
  releasedFence: number
  deadAcquisitionGeneration: string
  stableSettlementId: string
  settlementRetryRequired: boolean
}

export type StructuredAgentSessionUnexpectedExitContext = {
  store: AgentSessionRecordStore
  sessions: Map<string, StructuredAgentSessionHostSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishFence: (sessionId: string, session: StructuredAgentSessionHostSession) => void
  hasResumeCapableHolder: (sessionId: string) => boolean
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  onBarrierError?: (sessionId: string, error: unknown) => void
}

export async function settleUnexpectedStructuredAgentSessionExit(
  context: StructuredAgentSessionUnexpectedExitContext,
  event: StructuredAgentSessionLifecycleEvent
): Promise<StructuredAgentSessionRecoveryTicket | null> {
  if (event.cause !== 'unexpected-exit') {
    return null
  }
  const unexpectedEvent = event as UnexpectedExitLifecycleEvent
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
      return null
    }

    let settlementRetryRequired = false
    let settlementFailed = false
    const stableSettlementId = providerExitSettlementId(unexpectedEvent)
    let released: Awaited<
      ReturnType<typeof releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit>
    > | null = null
    try {
      try {
        const barrier = await context.flushLifecycle(unexpectedEvent.sessionId)
        if (!barrier.ok) {
          settlementRetryRequired = true
          context.onBarrierError?.(unexpectedEvent.sessionId, barrier.error)
        }
      } catch (error) {
        settlementRetryRequired = true
        context.onBarrierError?.(unexpectedEvent.sessionId, error)
      }
      if (unexpectedEvent.settlementRetryRequired || settlementRetryRequired) {
        const retried = await retryUnexpectedExitSettlement({
          context,
          event: unexpectedEvent,
          session,
          stableSettlementId
        })
        if (!retried) {
          settlementFailed = true
        }
        if (!settlementFailed) {
          settlementRetryRequired = false
        }
      }
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
          ...(settlementFailed
            ? {
                settlementRetry: {
                  settlementId: stableSettlementId,
                  detail: `provider exited: ${unexpectedEvent.reason}`.slice(0, 512)
                }
              }
            : {})
        })
      } catch (error) {
        context.onBarrierError?.(unexpectedEvent.sessionId, error)
      } finally {
        session.hasProviderChild = false
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
      stableSettlementId,
      settlementRetryRequired
    }
  })
}

export function isStructuredAgentSessionRecoveryTicketCurrent(
  context: Pick<
    StructuredAgentSessionUnexpectedExitContext,
    'store' | 'sessions' | 'hasResumeCapableHolder'
  >,
  ticket: StructuredAgentSessionRecoveryTicket
): boolean {
  const session = context.sessions.get(ticket.sessionId)
  const record = context.store.getRecord(ticket.sessionId)
  return (
    !ticket.settlementRetryRequired &&
    session?.hasProviderChild === false &&
    session.fence === ticket.releasedFence &&
    session.acquisitionGeneration === ticket.deadAcquisitionGeneration &&
    record?.lease.runtimeFence === ticket.releasedFence &&
    record.lease.claimStatus === 'released' &&
    record.lease.handoffStage === null &&
    context.hasResumeCapableHolder(ticket.sessionId)
  )
}

export async function retryUnexpectedExitSettlement(input: {
  context: StructuredAgentSessionUnexpectedExitContext
  event: UnexpectedExitLifecycleEvent
  session: StructuredAgentSessionHostSession
  stableSettlementId: string
}): Promise<boolean> {
  try {
    const mutations = unexpectedExitFallbackMutations(
      input.event,
      input.session,
      input.stableSettlementId
    )
    for (const chunk of partitionJournalLifecycleMutations(input.stableSettlementId, mutations)) {
      await input.session.journal.appendLifecycleBatch({
        settlementId: chunk.settlementId,
        fence: input.session.fence,
        recovered: true,
        mutations: chunk.mutations
      })
    }
    return true
  } catch (error) {
    input.context.onBarrierError?.(input.event.sessionId, error)
    return false
  }
}

function unexpectedExitFallbackMutations(
  event: UnexpectedExitLifecycleEvent,
  session: StructuredAgentSessionHostSession,
  stableSettlementId: string
): JournalLifecycleMutationInput[] {
  const mutations: JournalLifecycleMutationInput[] = []
  const tombstones: JournalLifecycleMutationInput[] = []
  for (const item of session.journal.snapshot().items) {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      continue
    }
    const terminal = terminalExitBody(item)
    if (terminal) {
      mutations.push({ kind: 'item', identity, body: terminal })
    }
    if (item.body.kind === 'status' && item.body.turnLifecycle?.state === 'running') {
      tombstones.push({ kind: 'tombstone', identity })
    }
  }
  mutations.push({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: stableSettlementId },
    body: { kind: 'status', text: boundJournalStatusText(`Provider exited: ${event.reason}`) }
  })
  mutations.push(...tombstones)
  return mutations
}

function terminalExitBody(item: AgentJournalRenderItem): AgentJournalItemBody | null {
  if (item.body.kind === 'tool-call' && item.body.state === 'running') {
    return { ...item.body, state: 'failed' }
  }
  if (item.body.kind === 'approval' || item.body.kind === 'question') {
    return item.body.resolution.state === 'pending' ? cancelledJournalPromptBody(item.body) : null
  }
  return null
}

function providerExitSettlementId(event: UnexpectedExitLifecycleEvent): string {
  return `provider-exit:${event.sessionId}:${event.fence}:${event.acquisitionGeneration}`
}
