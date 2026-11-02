import type { createFixture } from './queued-message-pause-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './journal-host-database'
import { liveTestJournalRows } from './journal-host-database-test-support'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { parseJournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'

export function registerQueuedMessageStopPauseTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe("the queue's pause, derived from the journal", () => {
    it("a person's Stop event pauses the queue, even with no card yet, survives reopen, and stores nothing", async () => {
      let journal = await fixture.open()
      await fixture.userStop(journal)
      expect(fixture.reason(journal)).toBe('stopped')
      await fixture.queueDraft(journal, 'draft-1')
      await journal.close()
      journal = await fixture.open()
      expect(fixture.reason(journal)).toBe('stopped')
      expect(fixture.pauseTables()).toBe(0)
    })

    it("any turn sent after the Stop and accepted lifts it, Orca's own mail included", async () => {
      const journal = await fixture.open()
      await fixture.turn(journal, 'before-stop', false)
      await fixture.userStop(journal)
      // Late acceptance of a pre-Stop send cannot lift the pause.
      await fixture.acceptTurn(journal, 'before-stop')
      expect(fixture.reason(journal)).toBe('stopped')
      await fixture.turn(journal, 'mail', false)
      expect(fixture.reason(journal)).toBe('stopped')
      await fixture.acceptTurn(journal, 'mail')
      expect(fixture.reason(journal)).toBeNull()
    })

    it('a later Stop is the latest, and a Resume row lifts it', async () => {
      const journal = await fixture.open()
      await fixture.userStop(journal)
      await fixture.turn(journal, 'typed')
      expect(fixture.reason(journal)).toBeNull()
      await fixture.userStop(journal)
      expect(fixture.reason(journal)).toBe('stopped')
      await journal.appendQueueResume(0)
      expect(fixture.reason(journal)).toBeNull()
      await fixture.userStop(journal)
      expect(fixture.reason(journal)).toBe('stopped')
      expect(fixture.pauseTables()).toBe(0)
    })

    it('a card kept by /clear stays paused until Resume in the same journal', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'carried')
      await fixture.clearContext(journal)
      expect(fixture.reason(journal)).toBe('cleared')
      await journal.close()
      journal = await fixture.open()
      expect(fixture.reason(journal)).toBe('cleared')
      await journal.appendQueueResume(0)
      expect(fixture.reason(journal)).toBeNull()
      expect(fixture.pauseTables()).toBe(0)
    })

    it('any accepted turn after /clear lifts its pause, a launch prompt Orca sent included', async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'carried')
      await fixture.clearContext(journal)
      await fixture.turn(journal, 'launch', false)
      expect(fixture.reason(journal)).toBe('cleared')
      await fixture.acceptTurn(journal, 'launch')
      expect(fixture.reason(journal)).toBeNull()
    })

    it('rides a tombstone of an id no item takes, so an older build reads it and changes nothing', async () => {
      const journal = await fixture.open()
      await fixture.turn(journal, 'typed')
      await journal.appendStopEvent(
        { reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' },
        0
      )
      const db = new Database(journalDatabasePath(fixture.root), { readonly: true })
      const stored = liveTestJournalRows(db, fixture.IDENTITY.sessionId)
      db.close()
      const parsed = parseJournalRow(stored.at(-1)?.rowJson ?? '')
      expect(parsed).toMatchObject({
        ok: true,
        row: {
          kind: 'tombstone',
          stopEvent: { reason: 'user-stop', turnId: 'turn-1', caller: 'client-1' }
        }
      })
      if (!parsed.ok || parsed.row.kind !== 'tombstone') {
        throw new Error('expected a tombstone row')
      }
      expect(parsed.row.stopEvent?.at).toBe(parsed.row.ts)
      // Older readers ignore the annotation and remove a nonexistent item.
      const { stopEvent: _ignored, ...asOlderBuildReadsIt } = parsed.row
      const state = createJournalReducerState(fixture.IDENTITY.sessionId, parsed.row.epoch)
      for (const row of stored.slice(0, -1)) {
        const earlier = parseJournalRow(row.rowJson)
        if (earlier.ok) {
          applyJournalRow(state, earlier.row)
        }
      }
      const items = [...state.items.keys()]
      const submissions = [...state.submissions.keys()]
      applyJournalRow(state, asOlderBuildReadsIt)
      expect([...state.items.keys()]).toEqual(items)
      expect([...state.submissions.keys()]).toEqual(submissions)
    })

    it('a Stop or Resume row holding a value no build writes is ignored on read, never trusted', async () => {
      let journal = await fixture.open()
      await fixture.queueDraft(journal, 'held')
      const corrupted = async (
        append: Promise<{ sequence: number }>,
        key: string,
        value: unknown
      ) => {
        const { sequence } = await append
        await journal.close()
        fixture.rewriteRows({ [sequence]: [key, value] })
        journal = await fixture.open()
      }
      const malformed = [null, 'stopped', { at: 1 }]
      for (const value of malformed) {
        await corrupted(fixture.userStop(journal), 'stopEvent', value)
        expect(fixture.reason(journal)).toBeNull()
      }
      await fixture.userStop(journal)
      for (const value of malformed) {
        await corrupted(fixture.userStop(journal), 'stopEvent', value)
        expect(fixture.reason(journal)).toBe('stopped')
      }
      await corrupted(journal.appendQueueResume(0), 'queueResume', 'yes')
      expect(fixture.reason(journal)).toBe('stopped')
      expect(fixture.held(journal)).toEqual([['held', true]])
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

    it("only a person's Stop pauses: a host's, a close's or an unknown reason holds nothing", async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'draft-1')
      for (const reason of ['user-close', 'host-stop', 'evict'] as const) {
        await journal.appendStopEvent({ reason }, 0)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately outside the type, as a newer build could write it.
      await journal.appendStopEvent({ reason: 'future-reason' as 'evict' }, 0)
      expect(fixture.reason(journal)).toBeNull()
    })

    it("a later Stop of any reason ends a person's Stop, without pausing itself", async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'draft-1')
      for (const later of ['host-stop', 'evict', 'user-close'] as const) {
        await fixture.userStop(journal)
        expect(fixture.held(journal)).toEqual([['draft-1', true]])
        await journal.appendStopEvent({ reason: later }, 0)
        expect(fixture.reason(journal)).toBeNull()
        expect(fixture.held(journal)).toEqual([['draft-1', false]])
      }
    })

    it("a person's Stop with no later Stop event is not lifted", async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'held')
      await fixture.userStop(journal)
      // Eviction rows must describe ended work or they would incorrectly lift this pause.
      expect(fixture.reason(journal)).toBe('stopped')
      expect(fixture.held(journal)).toEqual([['held', true]])
    })

    it('the restated Stop is the same event: its reason, turn, caller and time', async () => {
      const journal = await fixture.open()
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-7', caller: 'phone' }, 0)
      const stopped = fixture.stopEvents()
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(fixture.stopEvents()).toEqual(stopped)
      expect(stopped).toEqual([
        { reason: 'user-stop', turnId: 'turn-7', caller: 'phone', at: expect.any(Number) }
      ])
    })

    it.each([
      ['an accepted turn', (journal: AgentSessionJournal) => fixture.turn(journal, 'typed')],
      ['a Resume', (journal: AgentSessionJournal) => journal.appendQueueResume(0)]
    ])('a /clear pause %s already lifted stays lifted across a rewind', async (_name, lift) => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'carried')
      await fixture.clearContext(journal)
      await lift(journal)
      expect(fixture.reason(journal)).toBeNull()
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(fixture.reason(journal)).toBeNull()
    })

    it('a lifted /clear pause and a later Stop are both restated, the Stop still in force', async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'carried')
      await fixture.clearContext(journal)
      await fixture.turn(journal, 'typed')
      await fixture.userStop(journal)
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(journal.queuedMessages.pauses().map((pause) => pause.reason)).toEqual(['stopped'])
      await journal.appendQueueResume(0)
      expect(fixture.reason(journal)).toBeNull()
    })
  })
}
