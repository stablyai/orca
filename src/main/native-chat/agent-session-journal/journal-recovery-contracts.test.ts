import { afterEach, describe, vi } from 'vitest'
import { registerJournalStoreTests } from './journal-store.spec'
import { registerJournalCrashBoundaryTests } from './journal-crash-boundary.spec'
import { registerJournalEpochReplacementTests } from './journal-epoch-replacement.spec'
import { registerJournalItemProvenanceTests } from './journal-item-provenance.spec'
import { registerJournalLifecycleBatchAppenderTests } from './journal-lifecycle-batch-appender.spec'
import { registerJournalUnknownContentTests } from './journal-unknown-content.spec'
import { registerJournalUnknownRowKindTests } from './journal-unknown-row-kind.spec'
import { registerJournalStopAndResumeRowsTests } from './journal-stop-and-resume-rows.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-store', registerJournalStoreTests)
describe('journal-crash-boundary', registerJournalCrashBoundaryTests)
describe('journal-epoch-replacement', registerJournalEpochReplacementTests)
describe('journal-item-provenance', registerJournalItemProvenanceTests)
describe('journal-lifecycle-batch-appender', registerJournalLifecycleBatchAppenderTests)
describe('journal-unknown-content', registerJournalUnknownContentTests)
describe('journal-unknown-row-kind', registerJournalUnknownRowKindTests)
describe('journal-stop-and-resume-rows', registerJournalStopAndResumeRowsTests)
