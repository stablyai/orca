import { afterEach, describe, vi } from 'vitest'
import { registerJournalDispatchReasonBoundTests } from '../projection/journal-dispatch-reason-bound.spec'
import { registerJournalQueuedRejectionBatchTests } from '../submissions/journal-queued-rejection-batch.spec'
import { registerJournalRowContextUsageTests } from '../durable-rows/journal-row-context-usage.spec'
import { registerJournalSubagentItemTests } from '../item-lifecycle/journal-subagent-item.spec'
import { registerJournalSubmissionPositionsTests } from '../submissions/journal-submission-positions.spec'
import { registerJournalSubmissionQueuedLinkTests } from '../submissions/journal-submission-queued-link.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-dispatch-reason-bound', registerJournalDispatchReasonBoundTests)
describe('journal-queued-rejection-batch', registerJournalQueuedRejectionBatchTests)
describe('journal-row-context-usage', registerJournalRowContextUsageTests)
describe('journal-subagent-item', registerJournalSubagentItemTests)
describe('journal-submission-positions', registerJournalSubmissionPositionsTests)
describe('journal-submission-queued-link', registerJournalSubmissionQueuedLinkTests)
