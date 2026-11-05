import { createFixture } from './journal-store-contract-test-fixture'
import { registerJournalSequenceReplayTests } from '../writing/journal-sequence-replay.spec'
import { registerJournalLifecycleBoundaryTests } from '../context-epochs/journal-lifecycle-boundaries.spec'

export function registerJournalStoreTests(): void {
  const fixture = createFixture()
  registerJournalSequenceReplayTests(fixture)
  registerJournalLifecycleBoundaryTests(fixture)
}
