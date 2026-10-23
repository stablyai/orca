import { afterEach, describe, vi } from 'vitest'
import { registerJournalAtomicTerminalSettlementTests } from './journal-atomic-terminal-settlement.spec'
import { registerJournalDispatchReasonBoundTests } from './journal-dispatch-reason-bound.spec'
import { registerJournalQueuedRejectionBatchTests } from './journal-queued-rejection-batch.spec'
import { registerJournalRowContextUsageTests } from './journal-row-context-usage.spec'
import { registerJournalSubagentItemTests } from './journal-subagent-item.spec'
import { registerJournalSubagentLivenessTests } from './journal-subagent-liveness.spec'
import { registerJournalSubmissionPositionsTests } from './journal-submission-positions.spec'
import { registerJournalSubmissionQueuedLinkTests } from './journal-submission-queued-link.spec'
import { registerJournalTerminalSettlementValidationTests } from './journal-terminal-settlement-validation.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-atomic-terminal-settlement', registerJournalAtomicTerminalSettlementTests)
describe('journal-dispatch-reason-bound', registerJournalDispatchReasonBoundTests)
describe('journal-queued-rejection-batch', registerJournalQueuedRejectionBatchTests)
describe('journal-row-context-usage', registerJournalRowContextUsageTests)
describe('journal-subagent-item', registerJournalSubagentItemTests)
describe('journal-subagent-liveness', registerJournalSubagentLivenessTests)
describe('journal-submission-positions', registerJournalSubmissionPositionsTests)
describe('journal-submission-queued-link', registerJournalSubmissionQueuedLinkTests)
describe('journal-terminal-settlement-validation', registerJournalTerminalSettlementValidationTests)
