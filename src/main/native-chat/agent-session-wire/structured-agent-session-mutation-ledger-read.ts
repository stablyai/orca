// The ledger reads mutation admission makes before it writes. Receipts live in SQLite, so a read
// can fail like a write: a Stop must still reach the agent, and every other call refuses.

import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import {
  evaluateAgentSessionMutationWithoutLedger,
  type AgentSessionMutationOperationAdmission
} from '../../runtime/agent-session-operation-admission'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  classifyJournalOpenFailure,
  journalOpenRefusal
} from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type LedgerAnswer = ReturnType<AgentSessionRecordStore['evaluateMutationOperation']>

/** A store refusing the row (a newer Orca's records) or damage SQLite proves: as an open says. */
export function ledgerFailureRefusal(error: unknown): AgentSessionWireRefusal {
  if (isAgentSessionRefusalError(error) || classifyJournalOpenFailure(error) === 'journalCorrupt') {
    return journalOpenRefusal(error)
  }
  throw error
}

/** The ledger's answer; when it can't be read, the answer with no recorded row and the failure. */
export function evaluateLedgerOrAssumeNoRow(
  store: Pick<AgentSessionRecordStore, 'evaluateMutationOperation' | 'getRecord'>,
  operation: AgentSessionMutationOperationAdmission
): { answer: LedgerAnswer; failure: { error: unknown } | null } {
  try {
    return { answer: store.evaluateMutationOperation(operation), failure: null }
  } catch (error) {
    const record = store.getRecord(operation.envelope.sessionId)
    return {
      answer: evaluateAgentSessionMutationWithoutLedger(record, operation),
      failure: { error }
    }
  }
}

/** A Stop must reach the agent, so a ledger it can't read leaves it a first run. Any other call
 *  refuses: admitting without the row could run its effect twice. */
export function readMutationLedger(
  request: {
    store: AgentSessionRecordStore
    logger: StructuredAgentSessionLogger
    plan: { runsWithoutLedgerRow?: true }
  },
  operation: AgentSessionMutationOperationAdmission
): { ok: true; answer: LedgerAnswer } | { ok: false; refusal: AgentSessionWireRefusal } {
  const { answer, failure } = evaluateLedgerOrAssumeNoRow(request.store, operation)
  if (!failure) {
    return { ok: true, answer }
  }
  if (!request.plan.runsWithoutLedgerRow) {
    return { ok: false, refusal: ledgerFailureRefusal(failure.error) }
  }
  request.logger.warn("reading Stop's ledger row failed; Stop runs as if none were recorded", {
    scope: 'stop-ledger-row',
    sessionId: operation.envelope.sessionId,
    error: failure.error
  })
  return { ok: true, answer }
}
