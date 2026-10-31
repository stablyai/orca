import type { createFixture } from './queued-message-pause-contract-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './journal-host-database'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import type { AgentSessionJournal } from './journal-store'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'

export function registerQueuedMessageReopenPauseTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('which cards a pause holds', () => {
    it('only cards queued before the Stop event: one queued after it is a new instruction', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'before')
      await fixture.userStop(journal)
      await fixture.queueDraft(journal, 'after')
      expect(fixture.held(journal)).toEqual([
        ['before', true],
        ['after', false]
      ])
      await journal.close()
      journal = await fixture.open()
      expect(fixture.held(journal)).toEqual([
        ['before', true],
        ['after', false]
      ])
    })

    it('a steer the Stop withdrew comes back in its own place, and is held', async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'steered')
      await journal.appendSubmission(
        {
          clientMessageId: 'send-now-1',
          payloadFingerprint: fixture.fingerprintOf('steered'),
          body: fixture.message('steered'),
          fence: 0,
          handoverRecorded: true
        },
        { messageId: 'steered', expect: 'waiting' }
      )
      await fixture.userStop(journal)
      await fixture.queueDraft(journal, 'after')
      await journal.resolveDispatch({
        clientMessageId: 'send-now-1',
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
        fence: 0
      })
      expect(fixture.held(journal)).toEqual([
        ['steered', true],
        ['after', false]
      ])
    })

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

    it("'cleared' holds the cards already queued, not one typed after it", async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'carried-1')
      await fixture.queueDraft(journal, 'carried-2')
      await fixture.clearContext(journal)
      await fixture.queueDraft(journal, 'typed-here')
      expect(fixture.held(journal)).toEqual([
        ['carried-1', true],
        ['carried-2', true],
        ['typed-here', false]
      ])
    })
  })

  describe("a reopen's pause", () => {
    /** Reopen as a new handle; failMark injects a reopen-mark write failure. */
    async function reopen(
      journal: AgentSessionJournal,
      failMark = false
    ): Promise<AgentSessionJournal> {
      await journal.close()
      const reopened = await fixture.open()
      if (failMark) {
        vi.spyOn(reopened, 'appendQueueReopen').mockRejectedValueOnce(new Error('disk full'))
        await expect(reopened.markQueueReopen(0)).rejects.toThrow('disk full')
      } else {
        await reopened.markQueueReopen(0)
      }
      return reopened
    }

    it('holds the cards queued before the reopen, never one queued after its mark', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'before')
      expect(fixture.reason(journal)).toBeNull()
      journal = await reopen(journal)
      await fixture.queueDraft(journal, 'after')
      expect(fixture.held(journal)).toEqual([
        ['before', true],
        ['after', false]
      ])
      expect(fixture.reason(journal)).toBe('restarted')
    })

    it.each([
      ['an accepted turn', (journal: AgentSessionJournal) => fixture.turn(journal, 'carry-on')],
      ['a Resume', (journal: AgentSessionJournal) => journal.appendQueueResume(0)]
    ])('%s after the reopen lifts it', async (_name, lift) => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'before')
      journal = await reopen(journal)
      await lift(journal)
      expect(fixture.reason(journal)).toBeNull()
    })

    it('a turn the agent has not accepted yet lifts nothing', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'before')
      journal = await reopen(journal)
      await fixture.turn(journal, 'carry-on', false)
      expect(fixture.reason(journal)).toBe('restarted')
    })

    it('marks a reopen whose only card is mid-hand-off, and holds it once it comes back', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'in-flight')
      await journal.appendSubmission(
        {
          clientMessageId: 'drain-1',
          payloadFingerprint: fixture.fingerprintOf('in-flight'),
          body: fixture.message('in-flight'),
          fence: 0,
          handoverRecorded: true
        },
        { messageId: 'in-flight', expect: 'waiting' }
      )
      journal = await reopen(journal)
      await journal.resolveDispatch({
        clientMessageId: 'drain-1',
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('notDelivered'), {
          surface: 'rejection'
        }),
        fence: 0
      })
      expect(fixture.held(journal)).toEqual([['in-flight', true]])
    })

    it('a mark written late starts where the chat stopped, and narrows no earlier mark', async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'kept')
      const stopped = journal.cursor().sequence + 1
      await fixture.turn(journal, 'later')
      await journal.markQueueReopen(0, stopped)
      expect(fixture.reason(journal)).toBeNull()

      const reopened = await reopen(journal)
      expect(fixture.reason(reopened)).toBe('restarted')
      await reopened.markQueueReopen(0, stopped)
      expect(fixture.reason(reopened)).toBe('restarted')
    })

    it('a reopen with no waiting card writes nothing', async () => {
      let journal = await fixture.open()
      await fixture.turn(journal, 'earlier')
      const before = journal.cursor()
      journal = await reopen(journal)
      expect(journal.cursor()).toEqual(before)
      await fixture.queueDraft(journal, 'after')
      expect(fixture.held(journal)).toEqual([['after', false]])
    })

    it('a second reopen before any turn still holds them; one after a turn holds them again', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'before')
      journal = await reopen(journal)
      journal = await reopen(journal)
      expect(fixture.reason(journal)).toBe('restarted')
      await fixture.turn(journal, 'carry-on')
      expect(fixture.reason(journal)).toBeNull()
      journal = await reopen(journal)
      expect(fixture.reason(journal)).toBe('restarted')
    })

    it('without a mark the open itself is where the pause begins', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'before')
      journal = await reopen(journal, true)
      expect(fixture.held(journal)).toEqual([['before', true]])
      await fixture.turn(journal, 'carry-on')
      expect(fixture.reason(journal)).toBeNull()
    })

    it("reads an earlier build's stored 'kept' and 'stopped' holds as none; send_failed stays", async () => {
      let journal = await fixture.open()
      const db = new Database(journalDatabasePath(fixture.root))
      for (const [position, id, stored] of [
        [1, 'was-kept', 'kept'],
        [2, 'was-stopped', 'stopped'],
        [3, 'failed', 'send_failed']
      ] as const) {
        db.prepare(
          `INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint,
             created_at, host_instance, state, hold_reason)
           VALUES (?, ?, ?, ?, '', 0, 'earlier', 'waiting', ?)`
        ).run(fixture.IDENTITY.sessionId, id, position, JSON.stringify(fixture.message(id)), stored)
      }
      db.close()
      journal = await reopen(journal)
      expect(journal.queuedMessages.list().map((row) => [row.messageId, row.holdReason])).toEqual([
        ['was-kept', null],
        ['was-stopped', null],
        ['failed', 'send_failed']
      ])
      expect(fixture.held(journal)).toEqual([
        ['was-kept', true],
        ['was-stopped', true],
        ['failed', false]
      ])
    })
  })
}
