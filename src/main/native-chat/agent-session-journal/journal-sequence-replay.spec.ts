import type { createFixture } from './journal-store-contract-test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  boundJournalKeyComponent,
  MAX_JOURNAL_KEY_COMPONENT_CHARS
} from '../../../shared/agent-session-journal-item-key'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { AgentSessionJournalError } from './journal-store'
import {
  openTestJournalHostDatabase,
  liveTestJournalRows,
  deleteTestJournalRow,
  seedLegacyTestJournal,
  pinTestJournalInputMode
} from './journal-host-database-test-support'

export function registerJournalSequenceReplayTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('sequences', () => {
    it('assigns a contiguous sequence with no gaps or reuse under concurrent appends', async () => {
      const journal = await fixture.open()
      const results = await Promise.all(
        Array.from({ length: 25 }, (_unused, index) =>
          journal.appendItem(fixture.item(index), fixture.body(`m${index}`), {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
        )
      )
      const sequences = results.map((result) => result.cursor.sequence)
      expect(new Set(sequences).size).toBe(25)
      expect(sequences.slice().sort((a, b) => a - b)).toEqual(
        Array.from({ length: 25 }, (_unused, index) => index + 2)
      )
    })

    it('serializes revisions of one item so the last write wins deterministically', async () => {
      const journal = await fixture.open()
      const results = await Promise.all([
        journal.appendItem(fixture.item(0), fixture.body('a'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }),
        journal.appendItem(fixture.item(0), fixture.body('b'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }),
        journal.appendItem(fixture.item(0), fixture.body('c'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ])
      expect(results.map((result) => result.revision)).toEqual([1, 2, 3])
      expect(journal.snapshot().items).toHaveLength(1)
      expect(journal.snapshot().items[0]?.revision).toBe(3)
    })

    it('visits reduced items at their creation sequence without promoting an older revision', async () => {
      const journal = await fixture.open()
      await journal.appendItem(fixture.item(0), fixture.body('first'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const latest = await journal.appendItem(fixture.item(1), fixture.body('second'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendItem(fixture.item(0), fixture.body('first revised'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const visited: { itemId: string; sequence: number }[] = []

      journal.visitItems((itemId, sequence) => visited.push({ itemId, sequence }))

      expect(visited).toEqual([
        { itemId: agentJournalItemKey(fixture.item(0)), sequence: 2 },
        { itemId: latest.itemId, sequence: latest.cursor.sequence }
      ])
    })

    it('reads the live turn off reduced items, agreeing with the rendered snapshot', async () => {
      const journal = await fixture.open()
      const turnItem = (turnId: string): AgentJournalItemIdentity => ({
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'session-1',
        recordId: `turn-lifecycle:${turnId}`
      })
      const rendered = (): string | null =>
        activeStructuredAgentSessionTurnId(journal.snapshot().items)
      const bothAgreeOn = async (turnId: string | null): Promise<void> => {
        expect(journal.runningTurn()?.turnId ?? null).toBe(turnId)
        expect(rendered()).toBe(turnId)
      }

      await journal.appendItem(
        turnItem('turn-1'),
        { kind: 'turn', turnId: 'turn-1', state: 'running' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.appendItem(fixture.item(0), fixture.body('work'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await bothAgreeOn('turn-1')

      // Revisions retain creation position.
      await journal.appendItem(
        turnItem('turn-1'),
        { kind: 'turn', turnId: 'turn-1', state: 'completed' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await bothAgreeOn(null)

      await journal.appendItem(
        turnItem('turn-2'),
        { kind: 'turn', turnId: 'turn-2', state: 'running' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await bothAgreeOn('turn-2')
    })

    it('preserves an oversized identity and its raw digest-form mimic across reopen', async () => {
      const oversizedTurnId = 'a'.repeat(MAX_JOURNAL_KEY_COMPONENT_CHARS + 1)
      const digestFormMimic = boundJournalKeyComponent(oversizedTurnId)
      const identityFor = (turnId: string): AgentJournalItemIdentity => ({
        provider: 'codex',
        threadId: 'thread-1',
        turnId,
        ordinal: 0
      })
      const oversizedIdentity = identityFor(oversizedTurnId)
      const mimicIdentity = identityFor(digestFormMimic)
      const journal = await fixture.open()

      const oversized = await journal.appendItem(oversizedIdentity, fixture.body('oversized'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const mimic = await journal.appendItem(mimicIdentity, fixture.body('mimic'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      expect(oversized.itemId).not.toBe(mimic.itemId)
      expect([oversized.revision, mimic.revision]).toEqual([1, 1])

      const reopened = await fixture.open()
      expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([
        fixture.body('oversized'),
        fixture.body('mimic')
      ])

      await reopened.appendTombstone(oversizedIdentity, { fence: 1 })
      const afterTombstoneReopen = await fixture.open()
      expect(afterTombstoneReopen.snapshot().items.map((entry) => entry.body)).toEqual([
        fixture.body('mimic')
      ])
    })
  })

  describe('fences', () => {
    it('rejects an append from a writer behind the journal', async () => {
      const journal = await fixture.open()
      await journal.appendItem(fixture.item(0), fixture.body('a'), {
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await expect(
        journal.appendItem(fixture.item(1), fixture.body('b'), {
          fence: 6,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).rejects.toBeInstanceOf(AgentSessionJournalError)
    })

    it('keeps accepting appends after a rejected one', async () => {
      const journal = await fixture.open()
      await journal.appendItem(fixture.item(0), fixture.body('a'), {
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal
        .appendItem(fixture.item(1), fixture.body('b'), {
          fence: 6,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
        .catch(() => undefined)
      await journal.appendItem(fixture.item(2), fixture.body('c'), {
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([
        fixture.body('a'),
        fixture.body('c')
      ])
    })
  })

  describe('replay', () => {
    it('reopens to the same render model the live writer held', async () => {
      const journal = await fixture.open()
      await journal.appendItem(fixture.item(0), fixture.body('a'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendItem(fixture.item(1), fixture.body('b'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendItem(fixture.item(0), fixture.body('a2'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendTombstone(fixture.item(1), { fence: 1 })
      const live = journal.snapshot()

      const reopened = await fixture.open()
      expect(reopened.snapshot()).toEqual(live)
    })

    it('serves a resume from a cursor and refuses one from a stale epoch', async () => {
      const journal = await fixture.open()
      await journal.appendItem(fixture.item(0), fixture.body('a'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const cursor = journal.cursor()
      await journal.appendItem(fixture.item(1), fixture.body('b'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })

      const resumed = journal.readSince(cursor)
      expect(resumed.ok && resumed.rows).toHaveLength(1)

      await journal.rollEpoch('handle_forked', 2)
      expect(journal.readSince(cursor)).toEqual({ ok: false, reset: 'epoch_changed' })
    })

    it('rebuilds from a clean epoch after a rollover', async () => {
      const journal = await fixture.open()
      await journal.appendItem(fixture.item(0), fixture.body('a'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.rollEpoch('unreconcilable_prefix', 2)
      expect(journal.snapshot().items).toHaveLength(0)

      const reopened = await fixture.open()
      expect(reopened.epoch).toBe(journal.epoch)
      expect(reopened.snapshot().items).toHaveLength(0)
    })

    it('refuses a journal with a gap and keeps every row', async () => {
      seedLegacyTestJournal(openTestJournalHostDatabase(fixture.root), {
        identity: fixture.IDENTITY,
        now: fixture.tick
      })
      const journal = await fixture.open()
      pinTestJournalInputMode(journal)
      for (let index = 0; index < 4; index += 1) {
        await journal.appendItem(fixture.item(index), fixture.body(`m${index}`), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      }
      await journal.close()
      await fixture.withJournalDatabase(fixture.root, (db) => {
        deleteTestJournalRow(db, fixture.IDENTITY.sessionId, 3)
      })

      await expect(fixture.open()).rejects.toMatchObject({
        refusal: { details: { reason: 'journalCorrupt' } }
      })
      await fixture.withJournalDatabase(fixture.root, (db) => {
        const rows = liveTestJournalRows(db, fixture.IDENTITY.sessionId)
        expect(rows.map((row) => row.seq)).toEqual([1, 2, 4, 5])
      })
    })
  })
}
