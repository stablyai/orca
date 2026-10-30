import { createFixture } from './queued-message-pause-contract-test-fixture'
import { registerQueuedMessageStopPauseTests } from './queued-message-stop-pause.spec'
import { registerQueuedMessageReopenPauseTests } from './queued-message-reopen-pause.spec'
import { registerQueuedMessagePauseHeldCardsTests } from './queued-message-pause-held-cards.spec'

export function registerQueuedMessagePauseTests(): void {
  const fixture = createFixture()
  registerQueuedMessageStopPauseTests(fixture)
  registerQueuedMessageReopenPauseTests(fixture)
  registerQueuedMessagePauseHeldCardsTests()
}
