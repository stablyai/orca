import { createFixture } from './queued-message-pause-contract-test-fixture'
import { registerQueuedMessageStopPauseTests } from './queued-message-stop-pause.spec'

export function registerQueuedMessagePauseTests(): void {
  const fixture = createFixture()
  registerQueuedMessageStopPauseTests(fixture)
}
