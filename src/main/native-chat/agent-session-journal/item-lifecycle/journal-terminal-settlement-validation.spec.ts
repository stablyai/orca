import { createFixture } from './journal-terminal-validation-test-fixture'
import { registerJournalApprovalRevisionValidationTests } from './journal-approval-revision-validation.spec'

export function registerJournalTerminalSettlementValidationTests(): void {
  const fixture = createFixture()
  registerJournalApprovalRevisionValidationTests(fixture)
}
