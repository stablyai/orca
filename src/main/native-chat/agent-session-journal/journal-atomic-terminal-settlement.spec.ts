import { createFixture } from './journal-atomic-settlement-contract-test-fixture'
import { registerJournalAtomicSettlementRollbackTests } from './journal-atomic-settlement-rollback.spec'

export function registerJournalAtomicTerminalSettlementTests(): void {
  const fixture = createFixture()
  registerJournalAtomicSettlementRollbackTests(fixture)
}
