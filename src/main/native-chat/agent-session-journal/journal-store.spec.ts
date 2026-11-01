import { createFixture } from './journal-store-contract-test-fixture'
import { registerJournalSequenceReplayTests } from './journal-sequence-replay.spec'
import { registerJournalLifecycleBoundaryTests } from './journal-lifecycle-boundaries.spec'

export function registerJournalStoreTests(): void {
  const fixture = createFixture()
  registerJournalSequenceReplayTests(fixture)
  registerJournalLifecycleBoundaryTests(fixture)
}
