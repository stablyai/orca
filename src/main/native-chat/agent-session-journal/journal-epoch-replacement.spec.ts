import { createFixture } from './journal-epoch-replacement-contract-test-fixture'
import { registerJournalEpochReplacementReceiptsTests } from './journal-epoch-replacement-receipts.spec'

export function registerJournalEpochReplacementTests(): void {
  const fixture = createFixture()
  registerJournalEpochReplacementReceiptsTests(fixture)
}
