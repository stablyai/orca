import { createFixture } from './journal-atomic-settlement-contract-test-fixture'
import { registerJournalAtomicSettlementRollbackTests } from './journal-atomic-settlement-rollback.spec'
import { registerJournalAtomicSettlementOversizedTests } from './journal-atomic-settlement-oversized.spec'

export function registerJournalAtomicTerminalSettlementTests(): void {
  const fixture = createFixture()
  registerJournalAtomicSettlementRollbackTests(fixture)
  registerJournalAtomicSettlementOversizedTests(fixture)
}
