import { createFixture } from './journal-terminal-validation-test-fixture'
import { registerJournalTerminalTimeValidationTests } from './journal-terminal-time-validation.spec'
import { registerJournalApprovalRevisionValidationTests } from './journal-approval-revision-validation.spec'

export function registerJournalTerminalSettlementValidationTests(): void {
  const fixture = createFixture()
  registerJournalTerminalTimeValidationTests(fixture)
  registerJournalApprovalRevisionValidationTests(fixture)
}
