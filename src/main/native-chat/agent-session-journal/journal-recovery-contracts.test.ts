import { afterEach, describe, vi } from 'vitest'
import { registerJournalItemProvenanceTests } from './journal-item-provenance.spec'
import { registerJournalLifecycleBatchAppenderTests } from './journal-lifecycle-batch-appender.spec'
import { registerJournalUnknownRowKindTests } from './journal-unknown-row-kind.spec'
import { registerJournalStopAndResumeRowsTests } from './journal-stop-and-resume-rows.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-item-provenance', registerJournalItemProvenanceTests)
describe('journal-lifecycle-batch-appender', registerJournalLifecycleBatchAppenderTests)
describe('journal-unknown-row-kind', registerJournalUnknownRowKindTests)
describe('journal-stop-and-resume-rows', registerJournalStopAndResumeRowsTests)
