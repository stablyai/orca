import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachJournal } from './structured-agent-session-attach'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionLeaseStore } from './structured-agent-session-lease-release'
import {
  preserveStructuredSessionRetirement,
  retryStructuredSessionRetirements
} from './structured-agent-session-retirement'

export type StructuredAgentSessionSettlementCompletion = {
  sessionId: string
  journalChanged: boolean
  cursor: AgentJournalCursor
  settled: boolean
}

type SettlementDelivery = {
  onCompleted?: (result: StructuredAgentSessionSettlementCompletion) => void
}

export async function retryPendingStructuredAgentSessionSettlement(
  input: {
    deps: StructuredAgentSessionHostDeps
    sessions: Map<string, StructuredAgentSessionHostSession>
    sessionId: string
    params: AgentSessionAttachParams
    forAdmission?: boolean
    now: () => number
  } & SettlementDelivery
): Promise<boolean> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (
    !record ||
    (!record.lease.settlementRetryRequired &&
      !record.retirements?.receipts.length &&
      record.lease.claimStatus !== 'released')
  ) {
    return true
  }
  let journal = input.sessions.get(input.sessionId)?.journal
  if (!journal) {
    try {
      journal = (
        await attachJournal({
          record,
          params: input.params,
          journalRoot: input.deps.journalRoot,
          adapter: input.deps.adapter
        })
      ).journal
    } catch (error) {
      input.deps.onEventSinkError?.({ sessionId: input.sessionId, error })
      return false
    }
  }
  const current = input.sessions.get(input.sessionId)
  const retrySession =
    current ??
    ({
      journal,
      params: input.params,
      fence: record.lease.runtimeFence,
      hasProviderChild: false,
      acquisitionGeneration: null
    } as StructuredAgentSessionHostSession)
  try {
    let admissionAllowed = false
    const settled = await retryLoadedStructuredAgentSessionSettlement({
      deps: input.deps,
      sessionId: input.sessionId,
      session: retrySession,
      now: input.now,
      onCompleted: input.onCompleted,
      onRetirementPreserved: () => {
        admissionAllowed = true
      }
    })
    return input.forAdmission ? admissionAllowed : settled
  } finally {
    if (!current) {
      await agentSessionJournalCloseRetries.closeOrRetain(journal).catch((error: unknown) => {
        input.deps.onEventSinkError?.({ sessionId: input.sessionId, error })
      })
    }
  }
}

export async function retryLoadedStructuredAgentSessionSettlement(
  input: {
    deps: {
      store: StructuredAgentSessionLeaseStore
      onEventSinkError?: StructuredAgentSessionHostDeps['onEventSinkError']
    }
    sessionId: string
    session: Pick<StructuredAgentSessionHostSession, 'journal' | 'fence' | 'acquisitionGeneration'>
    onRetirementPreserved?: () => void
    now: () => number
  } & SettlementDelivery
): Promise<boolean> {
  const before = input.session.journal.cursor()
  let settled = false
  try {
    settled = await settleLoaded(input)
    return settled
  } finally {
    const cursor = input.session.journal.cursor()
    input.onCompleted?.({
      sessionId: input.sessionId,
      journalChanged: before.epoch !== cursor.epoch || before.sequence !== cursor.sequence,
      cursor,
      settled
    })
  }
}

async function settleLoaded(
  input: Parameters<typeof retryLoadedStructuredAgentSessionSettlement>[0]
): Promise<boolean> {
  const context = {
    store: input.deps.store,
    sessionId: input.sessionId,
    journal: input.session.journal,
    now: input.now,
    onError: (error: unknown) =>
      input.deps.onEventSinkError?.({ sessionId: input.sessionId, error })
  }
  if (!(await preserveStructuredSessionRetirement(context))) {
    return false
  }
  input.onRetirementPreserved?.()
  return retryStructuredSessionRetirements(context)
}
