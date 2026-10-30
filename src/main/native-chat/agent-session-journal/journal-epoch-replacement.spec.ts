import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import { replaceJournalEpoch } from './journal-epoch-replacement'
import type { JournalLoad } from './journal-open'
import type { AgentSessionJournal } from './journal-store'
import { readJournalSessionEpoch } from './journal-row-table'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'
import { formatNativeChatFileReference } from '../../../shared/agent-image-paste'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { markUnclaimedUploadForSweep } from '../agent-session-attachments/agent-session-attachment-claims'
import { JournalGoalAttachmentInverse } from './journal-goal-attachment-inverse'

export function registerJournalEpochReplacementTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }

  const PEER: AgentSessionJournalIdentity = {
    ...IDENTITY,
    sessionId: 'session-peer',
    providerHandle: codexProviderHandle('thread-peer')
  }

  let root: string
  let clock = 1_000
  let database: JournalHostDatabase
  const journals = createTrackedJournalOpener()

  function now(): number {
    clock += 1
    return clock
  }

  function storedRows(sessionId: string, epoch: string): number {
    return Number(
      database.db
        .prepare('SELECT count(*) AS total FROM journal_rows WHERE session_id = ? AND epoch = ?')
        .get(sessionId, epoch)?.total
    )
  }

  function item(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
  }

  function replace(input: {
    items: Parameters<typeof replaceJournalEpoch>[0]['items']
    onPublished?: (loaded: JournalLoad) => void
  }): void {
    replaceJournalEpoch({
      database,
      identity: IDENTITY,
      reason: 'legacy_import',
      fence: 1,
      items: input.items,
      queuePause: { lifted: false, liveStop: null, reopened: false },
      queue: { cards: [], receipt: { write: () => {}, committed: () => {} } },
      now,
      mintEpoch: () => `epoch-${clock}`,
      onPublished: input.onPublished ?? (() => undefined)
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-replace-'))
    clock = 1_000
    database = openTestJournalHostDatabase(root)
  })

  afterEach(async () => {
    try {
      await database.close()
    } catch {}
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('journal epoch replacement', () => {
    it('publishes one observable replacement', () => {
      const published: JournalLoad[] = []

      replace({
        items: [
          { identity: item(1), body: { kind: 'status', text: 'republished' }, ownerFence: 1 }
        ],
        onPublished: (loaded) => published.push(loaded)
      })

      expect(published).toHaveLength(1)
      const epoch = readJournalSessionEpoch(database.db, IDENTITY.sessionId)
      expect(epoch).toBe(published[0]?.state.epoch)
      expect(readTestJournalRows(database.db, IDENTITY.sessionId, epoch ?? '')).toHaveLength(2)
    })

    it.each([
      [
        'a replace',
        (journal: AgentSessionJournal) =>
          journal.replaceEpochItems('legacy_import', 1, [
            { identity: item(9), body: { kind: 'status', text: 'republished' }, ownerFence: 1 }
          ])
      ],
      ['a rollover', (journal: AgentSessionJournal) => journal.rollEpoch('handle_forked', 1)]
    ])('discards every superseded row in the same transaction as %s', async (_name, retire) => {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const peer = await journals.open({ identity: PEER, stateDirectory: root })
      const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      await journal.appendItem(item(1), { kind: 'status', text: 'old' }, scope)
      await journal.appendItem(item(2), { kind: 'status', text: 'older' }, scope)
      await peer.appendItem(item(1), { kind: 'status', text: 'peer' }, scope)
      const before = journal.epoch

      await retire(journal)

      expect(journal.epoch).not.toBe(before)
      expect(storedRows(IDENTITY.sessionId, before)).toBe(0)
      expect(storedRows(IDENTITY.sessionId, journal.epoch)).toBe(journal.cursor().sequence)
      expect(storedRows(PEER.sessionId, peer.epoch)).toBe(2)
    })
  })

  async function legacyInputs(count: number) {
    const existing = await journals.open({ identity: IDENTITY, stateDirectory: root })
    await existing.close()
    const files: { id: string; path: string; body: AgentJournalMessageItem }[] = []
    for (let n = 0; n < count; n++) {
      const id = randomUUID()
      const path = join(
        attachmentReferences.agentSessionAttachmentStoreRoot(root),
        id,
        'source.txt'
      )
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'queued source')
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: formatNativeChatFileReference(path) }]
      }
      database.db
        .prepare(`INSERT INTO queued_messages
        (session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state, hold_reason, returned_reason, consumed_as)
        VALUES (?, ?, ?, ?, ?, 0, 'earlier', ?, ?, ?, ?)`)
        .run(
          IDENTITY.sessionId,
          `queue-${n}`,
          n + 1,
          JSON.stringify(body),
          agentSessionSendBodyFingerprint(IDENTITY.sessionId, body),
          n % 2 ? 'returned' : 'waiting',
          n % 2 ? null : 'send_failed',
          n % 2 ? 'refused before' : null,
          n % 2 ? `old-${n}` : null
        )
      files.push({ id, path, body })
    }
    return files
  }

  it.each([
    ['replace', 1],
    ['replace', 10],
    ['roll', 1],
    ['roll', 10]
  ] as const)(
    'claims each actual carried card once through %s at Q=%i, with no prior claim and after reopen',
    async (mode, count) => {
      const files = await legacyInputs(count)
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const { db } = database
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
            identity: item(9),
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
      await journals.closeAll()
      const reopened = await journals.open({ identity: IDENTITY, stateDirectory: root })
      database = openTestJournalHostDatabase(root)
      expect(reopened.queuedMessages.list().map((card) => card.body)).toEqual(
        before.map((card) => card.body)
      )
      for (const file of files) {
        expect(markUnclaimedUploadForSweep(database.db, file.id, 1)).toBe(false)
        expect(await readFile(file.path, 'utf8')).toBe('queued source')
      }
    }
  )

  it.each(['replace', 'roll'] as const)(
    'finalizes %s queue ownership only after COMMIT and before fallible publication',
    async (mode) => {
      const [file] = await legacyInputs(1)
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
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
          const transaction = database.transaction.bind(database)
          vi.spyOn(database, 'transaction').mockImplementationOnce((run) =>
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
          database.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
        ).toHaveLength(phase === 'rollback' ? 0 : 1)
        expect(journal.queuedMessages.list()).toHaveLength(1)
      }
    }
  )
}
