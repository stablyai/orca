import type { createFixture } from './journal-epoch-replacement-contract-test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { JournalLoad } from './journal-open'
import type { AgentSessionJournal } from './journal-store'
import { readJournalSessionEpoch } from './journal-row-table'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { markUnclaimedUploadForSweep } from '../agent-session-attachments/agent-session-attachment-claims'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'
import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'

export function registerJournalEpochReplacementReceiptsTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('journal epoch replacement', () => {
    it('publishes one observable replacement', () => {
      const published: JournalLoad[] = []

      fixture.replace({
        items: [
          {
            identity: fixture.item(1),
            body: { kind: 'status', text: 'republished' },
            ownerFence: 1
          }
        ],
        onPublished: (loaded) => published.push(loaded)
      })

      expect(published).toHaveLength(1)
      const epoch = readJournalSessionEpoch(fixture.database.db, fixture.IDENTITY.sessionId)
      expect(epoch).toBe(published[0]?.state.epoch)
      expect(fixture.storedRows(fixture.IDENTITY.sessionId, epoch ?? '')).toBe(1)
      expect(published[0]?.state.lastSequence).toBe(2)
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
    ])('discards every superseded row in the same transaction as %s', async (_name, retire) => {
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

      await retire(journal)

      expect(journal.epoch).not.toBe(before)
      expect(fixture.storedRows(fixture.IDENTITY.sessionId, before)).toBe(0)
      expect(fixture.storedRows(fixture.IDENTITY.sessionId, journal.epoch)).toBe(1)
      expect(fixture.storedRows(fixture.PEER.sessionId, peer.epoch)).toBe(1)
    })
  })

  it.each([
    ['replace', 1],
    ['replace', 10],
    ['roll', 1],
    ['roll', 10]
  ] as const)(
    'claims each actual carried card once through %s at Q=%i, with no prior claim and after reopen',
    async (mode, count) => {
      const files = await fixture.legacyInputs(count)
      const journal = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      const { db } = fixture.database
      expect(
        db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
      ).toHaveLength(0)
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
      const extraction = vi.spyOn(attachmentReferences, 'agentSessionAttachmentReferences')
      const insertion = vi.spyOn(
        db.prepare(
          'INSERT OR IGNORE INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
        ),
        'run'
      )
      const acquired = vi.spyOn(JournalGoalAttachmentInverse.prototype, 'acquired')
      await (mode === 'replace'
        ? journal.replaceEpochItems('legacy_import', 1, [])
        : journal.rollEpoch('handle_forked', 1))
      expect(extraction).toHaveBeenCalledTimes(count)
      expect(insertion).toHaveBeenCalledTimes(count)
      expect(acquired).toHaveBeenCalledTimes(count)
      expect(cards()).toEqual(before)
      process.stdout.write(
        `pr34654-epoch-contract ${JSON.stringify({ mode, count, extractions: extraction.mock.calls.length, insertions: insertion.mock.calls.length, acquired: acquired.mock.calls.length })}\n`
      )
      await journal.withdrawGoalObjective(goal, { fence: 1 })
      expect(
        db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
      ).toHaveLength(count)
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
        extraction.mockClear()
        insertion.mockClear()
        acquired.mockClear()
        await journal.replaceEpochItems('legacy_import', 1, [
          {
            identity: fixture.item(9),
            body: card.body,
            ownerFence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ])
        expect(extraction).toHaveBeenCalledTimes(count + 2)
        expect(insertion).toHaveBeenCalledTimes(count + 2)
        expect(acquired).toHaveBeenCalledTimes(count + 2)
        expect(journal.submission('pending')).toMatchObject({
          dispatchState: 'pending',
          handoverRecorded: true,
          queuedMessageId: 'queue-0'
        })
        expect(journal.queuedMessages.get('queue-0')?.state).toBe('dispatched')
        expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([card.body, card.body])
        process.stdout.write(
          `pr34654-mixed-epoch-contract ${JSON.stringify({ q: count, i: 1, s: 1, extractions: extraction.mock.calls.length, insertions: insertion.mock.calls.length, acquired: acquired.mock.calls.length })}\n`
        )
      }
      await fixture.journals.closeAll()
      const reopened = await fixture.journals.open({
        identity: fixture.IDENTITY,
        stateDirectory: fixture.root
      })
      fixture.database = openTestJournalHostDatabase(fixture.root)
      expect(reopened.queuedMessages.list().map((card) => card.body)).toEqual(
        before.map((card) => card.body)
      )
      for (const file of files) {
        expect(markUnclaimedUploadForSweep(fixture.database.db, file.id, 1)).toBe(false)
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
          const transaction = fixture.database.transaction.bind(fixture.database)
          vi.spyOn(fixture.database, 'transaction').mockImplementationOnce((run) =>
            transaction((db) => {
              run(db)
              throw new Error('rollback epoch')
            })
          )
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
          fixture.database.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
        ).toHaveLength(phase === 'rollback' ? 0 : 1)
        expect(journal.queuedMessages.list()).toHaveLength(1)
      }
    }
  )
}
