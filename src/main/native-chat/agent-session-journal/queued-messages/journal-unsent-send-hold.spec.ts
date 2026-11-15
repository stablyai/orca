import { createFixture } from './journal-unsent-send-hold-contract-test-fixture'
import { registerJournalUnsentSendHoldQueueTests } from './journal-unsent-send-hold-queue.spec'

export function registerJournalUnsentSendHoldTests(): void {
  const fixture = createFixture()
  registerJournalUnsentSendHoldQueueTests(fixture)
}
