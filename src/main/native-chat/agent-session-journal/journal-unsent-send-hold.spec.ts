import { createFixture } from './journal-unsent-send-hold-contract-test-fixture'
import { registerJournalUnsentSendHoldRecoveryTests } from './journal-unsent-send-hold-recovery.spec'
import { registerJournalUnsentSendHoldQueueTests } from './journal-unsent-send-hold-queue.spec'

export function registerJournalUnsentSendHoldTests(): void {
  const fixture = createFixture()
  registerJournalUnsentSendHoldRecoveryTests(fixture)
  registerJournalUnsentSendHoldQueueTests(fixture)
}
