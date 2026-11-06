import type { createFixture } from './queued-message-pause-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'

export function registerQueuedMessageStopPauseTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe("the queue's pause, derived from the journal", () => {
    it('does not release a retained failure whose chronology was already made conservative by a real removal', async () => {
      const journal = await fixture.open()
      await fixture.turn(journal, 'accepted')
      const identity = { provider: 'claude', sessionId: 'native-1', uuid: 'F' } as const
      const body = { kind: 'turn', turnId: 'F', state: 'completed', outcome: 'failure' } as const
      const kept = [{ identity, body, ownerFence: 0 }]
      await journal.appendItem(identity, body, { fence: 0, turnScope: { kind: 'thread' } })
      await fixture.queueDraft(journal, 'carried')
      await journal.appendQueueResume(0)
      await journal.replaceEpochItems('handle_forked', 0, kept)
      expect(fixture.reason(journal)).toBeNull()
      const later = { ...identity, uuid: 'T' }
      await journal.appendItem(
        later,
        { ...body, turnId: 'T', outcome: 'success' },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      await journal.appendTombstone(later, { fence: 0 })
      expect(fixture.reason(journal)).toBe('failed')
      await journal.replaceEpochItems('handle_forked', 0, kept)
      expect(fixture.reason(journal)).toBe('failed')
      expect(journal.queuedMessages.nextInputCard()).toBeNull()
      await journal.appendQueueResume(0)
      expect(journal.queuedMessages.nextInputCard()?.messageId).toBe('carried')
    })

    it("the queue's own consume is refused in its transaction while the pause holds the card; Send-now is not", async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'draft-1')
      await fixture.userStop(journal)
      const consume = (id: string, automatic: boolean) =>
        journal.appendSubmission(
          {
            clientMessageId: id,
            payloadFingerprint: fixture.fingerprintOf('draft-1'),
            body: fixture.message('draft-1'),
            fence: 0,
            handoverRecorded: true
          },
          {
            messageId: 'draft-1',
            expect: 'waiting',
            ...(automatic ? { yieldsToPause: true as const } : {})
          }
        )
      await expect(consume('drain-1', true)).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
      expect(journal.submission('drain-1')).toBeUndefined()
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
      await consume('send-now-1', false)
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
    })

    it("a rewind's epoch replacement restates a Stop still pausing, and not one a turn ended", async () => {
      const journal = await fixture.open()
      await fixture.userStop(journal)
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(fixture.reason(journal)).toBe('stopped')
      await fixture.turn(journal, 'typed')
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(fixture.reason(journal)).toBeNull()
    })
  })
}
