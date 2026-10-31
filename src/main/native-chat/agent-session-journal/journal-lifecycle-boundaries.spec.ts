import type { createFixture } from './journal-store-contract-test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import {
  boundInlineText,
  boundPayload,
  JOURNAL_RUNNING_PREVIEW_LIMITS
} from './journal-payload-bounds'
import type { AgentSessionJournal } from './journal-store'

export function registerJournalLifecycleBoundaryTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('bounds', () => {
    it('marks a clipped payload instead of dropping bytes silently', () => {
      const limits = { inlineHeadBytes: 16 }
      const bounded = boundPayload('x'.repeat(4_096), limits)
      expect(bounded.truncated).toBe(true)
      expect(bounded.head).toHaveLength(16)
      expect(bounded.byteLength).toBe(4_096)
      expect(boundInlineText('x'.repeat(4_096), limits).text).toContain('output truncated')
    })

    it('never splits a multi-byte character across the bound', () => {
      const limits = { inlineHeadBytes: 4 }
      // Three-byte characters expose UTF-8 splits.
      const bounded = boundPayload('日本語テスト', limits)
      expect(bounded.head).toBe('日')
      expect(Buffer.byteLength(bounded.head, 'utf8')).toBeLessThanOrEqual(4)
    })

    it('leaves a payload inside the bound untouched', () => {
      const bounded = boundPayload('small', JOURNAL_RUNNING_PREVIEW_LIMITS)
      expect(bounded.truncated).toBe(false)
      expect(bounded.head).toBe('small')
      expect(boundInlineText('small', JOURNAL_RUNNING_PREVIEW_LIMITS).text).toBe('small')
    })
  })

  describe('lifecycle batches', () => {
    it('deduplicates concurrent submissions before appending a second row', async () => {
      const journal = await fixture.open()
      const input = {
        settlementId: 'concurrent-settlement',
        fence: 1,
        mutations: [
          {
            kind: 'item' as const,
            identity: fixture.item(1),
            body: fixture.body('settled'),
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
      }

      const [first, replay] = await Promise.all([
        journal.appendLifecycleBatch(input),
        journal.appendLifecycleBatch(input)
      ])

      expect([replay, first.sequence]).toEqual([first, 2])
    })

    it('applies every mutation at one sequence and deduplicates a replay across reopen', async () => {
      const journal = await fixture.open()
      const turn: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'session-1',
        recordId: 'turn-lifecycle:turn-1'
      }
      await journal.appendItem(
        turn,
        { kind: 'status', text: 'working' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )

      const settled = await journal.appendLifecycleBatch({
        settlementId: 'exit:turn-1',
        fence: 1,
        mutations: [
          {
            kind: 'item',
            identity: fixture.item(1),
            body: fixture.body('tool settled'),
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          },
          {
            kind: 'item',
            identity: { provider: 'orca', clientMessageId: 'exit-status' },
            body: { kind: 'status', text: 'Provider exited' },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          },
          { kind: 'tombstone', identity: turn }
        ]
      })
      const atSettlement = journal
        .snapshot()
        .items.filter((entry) => entry.sequence === settled.sequence)
      expect(atSettlement).toHaveLength(2)
      expect(
        journal
          .snapshot()
          .items.some((entry) => entry.body.kind === 'status' && entry.body.text === 'working')
      ).toBe(false)
      await journal.close()

      const reopened = await fixture.open()
      const beforeReplay = reopened.cursor()
      const replay = await reopened.appendLifecycleBatch({
        settlementId: 'exit:turn-1',
        fence: 1,
        mutations: [
          {
            kind: 'item',
            identity: fixture.item(9),
            body: fixture.body('must not appear'),
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
      })
      expect(replay).toEqual(beforeReplay)
      expect(
        reopened
          .snapshot()
          .items.some(
            (entry) =>
              entry.body.kind === 'message' &&
              entry.body.blocks.some(
                (block) => block.type === 'text' && block.text === 'must not appear'
              )
          )
      ).toBe(false)
    })
  })

  describe('on-disk layout', () => {
    it('keeps every chat of the state directory in its one database, and no per-chat file', async () => {
      const journal: AgentSessionJournal = await fixture.open()
      await journal.appendItem(fixture.item(0), fixture.body('a'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      expect(await readdir(fixture.root)).toContain('agent-session-journal.db')
      expect(await readdir(fixture.root)).not.toContain('agent-session-journal')
      await journal.close()
      await fixture.withJournalDatabase(fixture.root, (db) => {
        expect(
          db.prepare("SELECT value_json FROM journal_outcomes WHERE field = 'items'").get()
            ?.value_json
        ).toContain('"kind":"message"')
        expect(db.prepare('SELECT epoch FROM journal_sessions').get()).toMatchObject({
          epoch: journal.epoch
        })
      })
    })
  })

  describe('what a handle found on disk when it opened', () => {
    const submission = (clientMessageId: string) => ({
      clientMessageId,
      payloadFingerprint: 'fp',
      body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
      fence: 1,
      handoverRecorded: true as const
    })

    it('names rows an earlier handle wrote, and never a row of a later epoch', async () => {
      const earlier = await fixture.open()
      await earlier.appendItem(fixture.item(1), fixture.body('one'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await earlier.appendSubmission(submission('earlier'))
      await earlier.close()

      const journal = await fixture.open()
      const leftover = journal.submissions().find((entry) => entry.clientMessageId === 'earlier')
      expect(journal.wroteBeforeOpen(leftover?.acceptedSequence)).toBe(true)

      await journal.resolveDispatch({
        clientMessageId: 'earlier',
        state: 'unknown',
        reason: 'unconfirmed from an earlier host',
        fence: 1
      })
      // Epochs restart sequences, so later rows can fall below the old open cursor.
      await journal.replaceEpochItems('handle_forked', 1, [])
      await journal.appendSubmission(submission('later'))
      const later = journal.submissions().find((entry) => entry.clientMessageId === 'later')
      expect(later?.acceptedSequence).toBeLessThanOrEqual(2)
      expect(journal.wroteBeforeOpen(later?.acceptedSequence)).toBe(false)
    })
  })
}
