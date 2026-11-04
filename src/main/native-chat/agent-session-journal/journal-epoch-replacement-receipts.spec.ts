import type { createFixture } from './journal-epoch-replacement-contract-test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { AgentSessionJournal } from './journal-store'
import { failNextNativeJournalStatement } from './journal-native-test-instrumentation'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { readTestJournalRows } from './journal-host-database-test-support'

export function registerJournalEpochReplacementReceiptsTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('journal epoch replacement', () => {
    it('publishes one observable replacement and rolls back a failed receipt', async () => {
      const journal = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      const items: JournalReplacementItem[] = [
        { identity: fixture.item(1), body: { kind: 'status', text: 'republished' }, ownerFence: 1 }
      ]
      const before = journal.cursor()
      await expect(
        journal.replaceEpochItems('legacy_import', 1, items, () => ({
          write: () => {
            throw new Error('receipt failed')
          },
          committed: () => {}
        }))
      ).rejects.toThrow('receipt failed')
      expect(journal.cursor()).toEqual(before)
      let acknowledged = before
      await journal.replaceEpochItems('legacy_import', 1, items, (cursor) => ({
        write: () => {
          acknowledged = cursor
        },
        committed: () => {}
      }))
      expect(acknowledged).toEqual(journal.cursor())
      expect(await journal.readSince(before)).toEqual({ ok: false, reset: 'epoch_changed' })
      expect(
        await fixture.database.read(
          async (read) =>
            (
              await read
                .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
                .get(fixture.IDENTITY.sessionId)
            )?.epoch
        )
      ).toBe(before.epoch)
      const reopened = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      expect(reopened.cursor()).toEqual(journal.cursor())
      expect(reopened.snapshot()).toEqual(journal.snapshot())
    })

    it.each([
      [
        'a replace',
        (journal: AgentSessionJournal) =>
          journal.replaceEpochItems('legacy_import', 1, [
            {
              identity: fixture.item(9),
              body: { kind: 'status', text: 'republished' },
              ownerFence: 1
            }
          ])
      ],
      ['a rollover', (journal: AgentSessionJournal) => journal.rollEpoch('handle_forked', 1)]
    ])('retains canonical order while replacing presentation in %s', async (_name, retire) => {
      const journal = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      const peer = await fixture.journals.open({
        identity: fixture.PEER,
        stateDirectory: fixture.root
      })
      const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      await journal.appendItem(fixture.item(1), { kind: 'status', text: 'old' }, scope)
      await journal.appendItem(fixture.item(2), { kind: 'status', text: 'older' }, scope)
      await peer.appendItem(fixture.item(1), { kind: 'status', text: 'peer' }, scope)
      const before = journal.epoch
      const physical = await fixture.database.read(
        async (read) =>
          (
            await read
              .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
              .get(fixture.IDENTITY.sessionId)
          )?.epoch
      )
      if (typeof physical !== 'string') {
        throw new Error('missing physical epoch')
      }
      const oldCursor = journal.cursor()
      const oldRows = await readTestJournalRows(
        fixture.database,
        fixture.IDENTITY.sessionId,
        physical!
      )
      const oldOutcomes = await fixture.database.read((read) =>
        read
          .prepare(
            'SELECT * FROM journal_outcomes WHERE seq<=? ORDER BY generation,seq,field,entry_key'
          )
          .all(oldCursor.sequence)
      )

      await retire(journal)

      expect(journal.epoch).not.toBe(before)
      expect(
        await fixture.database.read(
          async (read) =>
            (
              await read
                .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
                .get(fixture.IDENTITY.sessionId)
            )?.epoch
        )
      ).toBe(physical)
      expect(await journal.readSince(oldCursor)).toEqual({ ok: false, reset: 'epoch_changed' })
      expect(await fixture.storedRows(fixture.IDENTITY.sessionId, before)).toBeGreaterThan(0)
      expect(
        (await readTestJournalRows(fixture.database, fixture.IDENTITY.sessionId, physical!)).slice(
          0,
          oldRows.length
        )
      ).toEqual(oldRows)
      expect(
        await fixture.database.read((read) =>
          read
            .prepare(
              'SELECT * FROM journal_outcomes WHERE seq<=? ORDER BY generation,seq,field,entry_key'
            )
            .all(oldCursor.sequence)
        )
      ).toEqual(oldOutcomes)
      expect(
        journal
          .snapshot()
          .items.some((row) => row.body.kind === 'status' && row.body.text === 'old')
      ).toBe(false)
      expect(await fixture.storedRows(fixture.PEER.sessionId, peer.epoch)).toBe(1)
      expect(peer.snapshot().items).toHaveLength(1)
    })
  })

  it.each(['replace', 'roll'] as const)(
    'preserves carried card attachments through %s and reopen',
    async (mode) => {
      const files = await fixture.legacyInputs(1)
      const journal = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      const claims = () =>
        fixture.database.read((read) =>
          read.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
        )
      expect(await claims()).toHaveLength(0)
      const cards = () =>
        journal.queuedMessages
          .list()
          .map(({ messageId, body, state, holdReason, returnedReason }) => ({
            messageId,
            body,
            state,
            holdReason,
            returnedReason
          }))
      const before = cards()
      const goal = { provider: 'orca' as const, clientMessageId: 'live-goal' }
      await journal.appendClaimingAttachments(
        goal,
        { ...files[0].body, sentAs: 'goal' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await (mode === 'replace'
        ? journal.replaceEpochItems('legacy_import', 1, [])
        : journal.rollEpoch('handle_forked', 1))
      expect(cards()).toEqual(before)
      await journal.withdrawGoalObjective(goal, { fence: 1 })
      expect(await claims()).toHaveLength(1)
      if (mode === 'replace') {
        const card = journal.queuedMessages.get('queue-0')
        if (!card) {
          throw new Error('missing carried card')
        }
        await journal.appendSubmission({
          clientMessageId: 'pending',
          payloadFingerprint: card.fingerprint,
          body: card.body,
          fence: 1,
          handoverRecorded: true,
          queuedMessageId: card.messageId
        })
        expect(journal.queuedMessages.get('queue-0')?.state).toBe('dispatched')
        await journal.replaceEpochItems('legacy_import', 1, [
          {
            identity: fixture.item(9),
            echoOf: null,
            body: card.body,
            ownerFence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ])
        expect(journal.submission('pending')).toMatchObject({
          dispatchState: 'pending',
          handoverRecorded: true,
          queuedMessageId: 'queue-0'
        })
        expect(journal.queuedMessages.get('queue-0')?.state).toBe('dispatched')
        expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([card.body, card.body])
      }
      await fixture.journals.closeAll()
      const reopened = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      fixture.database = await openTestJournalHostDatabase(fixture.root)
      expect(reopened.queuedMessages.list().map((card) => card.body)).toEqual(
        before.map((card) => card.body)
      )
      for (const file of files) {
        let marked: unknown
        await fixture.database.transaction((plan) =>
          plan.add(
            { kind: 'sweep', operation: { kind: 'mark', uploadId: file.id, now: 1 } },
            (result) => {
              marked = result
            }
          )
        )
        expect(marked).toBe(false)
        expect(await readFile(file.path, 'utf8')).toBe('queued source')
      }
    }
  )

  it.each(['replace', 'roll'] as const)(
    'finalizes %s queue ownership only after COMMIT and before fallible publication',
    async (mode) => {
      const [file] = await fixture.legacyInputs(1)
      const journal = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      for (const phase of ['rollback', 'publication'] as const) {
        const goal = { provider: 'orca' as const, clientMessageId: `goal-${phase}` }
        await journal.appendClaimingAttachments(
          goal,
          { ...file.body, sentAs: 'goal' },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        const retire = () =>
          mode === 'replace'
            ? journal.replaceEpochItems('legacy_import', 1, [])
            : journal.rollEpoch('handle_forked', 1)
        if (phase === 'rollback') {
          await failNextNativeJournalStatement(fixture.database, 'COMMIT', 'rollback epoch')
          await expect(retire()).rejects.toThrow('rollback epoch')
        } else {
          journal.observeCommits(() => {
            throw new Error('publication failed')
          })
          await expect(retire()).rejects.toThrow('publication failed')
          journal.observeCommits(() => {})
        }
        await journal.withdrawGoalObjective(goal, { fence: 1 })
        expect(
          await fixture.database.read((read) =>
            read.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
          )
        ).toHaveLength(phase === 'rollback' ? 0 : 1)
        expect(journal.queuedMessages.list()).toHaveLength(1)
      }
    }
  )
}
