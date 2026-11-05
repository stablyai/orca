import { afterEach, describe, vi } from 'vitest'
import { registerJournalStoreTests } from './journal-store.spec'
import { registerJournalCrashBoundaryTests } from '../submissions/journal-crash-boundary.spec'
import { registerJournalEpochReplacementTests } from '../context-epochs/journal-epoch-replacement.spec'
import { registerJournalItemProvenanceTests } from '../projection/journal-item-provenance.spec'
import { registerJournalLifecycleBatchAppenderTests } from '../writing/journal-lifecycle-batch-appender.spec'
import { registerJournalUnknownContentTests } from '../durable-rows/journal-unknown-content.spec'
import { registerJournalUnknownRowKindTests } from '../durable-rows/journal-unknown-row-kind.spec'
import { registerJournalStopAndResumeRowsTests } from '../context-epochs/journal-stop-and-resume-rows.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-store', registerJournalStoreTests)
describe('journal-crash-boundary', registerJournalCrashBoundaryTests)
describe('journal-epoch-replacement', registerJournalEpochReplacementTests)
describe('journal-item-provenance', registerJournalItemProvenanceTests)
describe('journal-lifecycle-batch-appender', registerJournalLifecycleBatchAppenderTests)
describe('journal-unknown-content', registerJournalUnknownContentTests)
describe('journal-unknown-row-kind', registerJournalUnknownRowKindTests)
describe('journal-stop-and-resume-rows', registerJournalStopAndResumeRowsTests)
