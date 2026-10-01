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
import { replaceJournalEpoch } from './journal-epoch-replacement'
import type { JournalLoad } from './journal-open'
import type { AgentSessionJournal } from './journal-store'
import { readJournalSessionEpoch } from './journal-row-table'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const PEER: AgentSessionJournalIdentity = {
  ...IDENTITY,
  sessionId: 'session-peer',
  providerHandle: { kind: 'codex', threadId: 'thread-peer' }
}

let root: string
let clock = 1_000
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()

function now(): number {
  clock += 1
  return clock
}

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
    queuePause: { lifted: false, liveStop: null },
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
    database.close()
  } catch {
    // Already closed by the case.
  }
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('journal epoch replacement', () => {
  it('publishes one observable replacement', () => {
    const published: JournalLoad[] = []

    replace({
      items: [{ identity: item(1), body: { kind: 'status', text: 'republished' } }],
      onPublished: (loaded) => published.push(loaded)
    })

    expect(published).toHaveLength(1)
    const epoch = readJournalSessionEpoch(database.db, IDENTITY.sessionId)
    expect(epoch).toBe(published[0]?.state.epoch)
    expect(readTestJournalRows(database.db, IDENTITY.sessionId, epoch ?? '')).toHaveLength(2)
  })

  // Keyed by identity: a retired epoch's rows go by (chat, epoch), and no other chat's go with them.
  it.each([
    [
      'a replace',
      (journal: AgentSessionJournal) =>
        journal.replaceEpochItems('legacy_import', 1, [
          { identity: item(9), body: { kind: 'status', text: 'republished' } }
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
