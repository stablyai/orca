import type { createFixture } from './queued-message-pause-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'

export function registerQueuedMessageReopenPauseTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('which cards a pause holds', () => {
    it("the queue's own consume refuses a newer card while an older one is held: nothing overtakes", async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'held')
      await fixture.userStop(journal)
      await fixture.queueDraft(journal, 'newer')
      await expect(
        journal.appendSubmission(
          {
            clientMessageId: 'drain-newer',
            payloadFingerprint: fixture.fingerprintOf('newer'),
            body: fixture.message('newer'),
            fence: 0,
            handoverRecorded: true
          },
          {
            messageId: 'newer',
            expect: 'waiting',
            yieldsToPause: true
          }
        )
      ).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
      expect(journal.queuedMessages.get('newer')?.state).toBe('waiting')
    })
  })
}
