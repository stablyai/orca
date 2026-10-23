import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Republishing an epoch is ONE transaction.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { AgentSessionJournal } from './journal-store'
import { readJournalSessionEpoch } from './journal-row-table'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

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
  let database: JournalHostDatabase
  const journals = createTrackedJournalOpener()

  /** Rows stored under the chat and epoch, whatever the chat's pointer names. */
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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-replace-'))
    database = openTestJournalHostDatabase(root)
  })

  afterEach(async () => {
    try {
      database.close()
    } catch {
      // Already closed by the case.
    }
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('journal epoch replacement', () => {
    it('publishes one observable replacement and rolls back a failed receipt', async () => {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const items: JournalReplacementItem[] = [
        { identity: item(1), body: { kind: 'status', text: 'republished' }, ownerFence: 1 }
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
      expect(journal.readSince(before)).toEqual({ ok: false, reset: 'epoch_changed' })
      expect(readJournalSessionEpoch(database.db, IDENTITY.sessionId)).toBe(before.epoch)
      const reopened = await journals.open({ identity: IDENTITY, stateDirectory: root })
      expect(reopened.cursor()).toEqual(journal.cursor())
      expect(reopened.snapshot()).toEqual(journal.snapshot())
    })

    // Keyed by identity: a retired epoch's rows go by (chat, epoch), and no other chat's go with them.
    it.each([
      [
        'a replace',
        (journal: AgentSessionJournal) =>
          journal.replaceEpochItems('legacy_import', 1, [
            { identity: item(9), body: { kind: 'status', text: 'republished' }, ownerFence: 1 }
          ])
      ],
      ['a rollover', (journal: AgentSessionJournal) => journal.rollEpoch('handle_forked', 1)]
    ])('retains canonical order while replacing presentation in %s', async (_name, retire) => {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const peer = await journals.open({ identity: PEER, stateDirectory: root })
      const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      await journal.appendItem(item(1), { kind: 'status', text: 'old' }, scope)
      await journal.appendItem(item(2), { kind: 'status', text: 'older' }, scope)
      await peer.appendItem(item(1), { kind: 'status', text: 'peer' }, scope)
      const before = journal.epoch

      await retire(journal)

      expect(journal.epoch).not.toBe(before)
      expect(storedRows(IDENTITY.sessionId, before)).toBe(journal.cursor().sequence)
      expect(
        readTestJournalRows(database.db, IDENTITY.sessionId, before)
          .slice(0, 3)
          .map((row) => row.seq)
      ).toEqual([1, 2, 3])
      expect(
        journal
          .snapshot()
          .items.some((row) => row.body.kind === 'status' && row.body.text === 'old')
      ).toBe(false)
      expect(storedRows(PEER.sessionId, peer.epoch)).toBe(2)
    })
  })
}
