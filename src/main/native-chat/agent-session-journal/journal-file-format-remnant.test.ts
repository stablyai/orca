// An empty chat beside a pre-SQLite journal explains itself.
//
// The SQLite move shipped no importer, so a session whose history is a
// `log.jsonl` founds a fresh empty journal beside it and looks exactly like a
// chat created seconds ago. One status row is the difference.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { openJournalDatabase } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY } from './journal-file-format-remnant'
import { loadJournal } from './journal-open'
import { journalDatabaseFile } from './journal-paths'
import type { AgentSessionJournal } from './journal-store'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const DISCLOSURE_ITEM_ID = agentJournalItemKey(JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY)

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

function writeRemnant(name = 'log.jsonl'): Promise<void> {
  return writeFile(join(root, name), '{"kind":"epoch","v":1,"seq":1}\n', 'utf8')
}

function disclosure(journal: AgentSessionJournal): string | null {
  const row = journal.snapshot().items.find((entry) => entry.itemId === DISCLOSURE_ITEM_ID)
  return row?.body.kind === 'status' ? row.body.text : null
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-remnant-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a chat whose history is still in the pre-SQLite format', () => {
  it('says how to carry on, and where the transcript is', async () => {
    await writeRemnant()

    const journal = await open()

    expect(disclosure(journal)).toContain('send a message to pick up where you left off')
    expect(disclosure(journal)).toContain(join(root, 'log.jsonl'))
    expect(disclosure(journal)).toContain('Codex')
  })

  // Both files is the normal shape of a pre-SQLite directory: every epoch roll
  // staged a snapshot whether or not anything compacted into it, so preferring
  // the snapshot would name an empty file for ~every affected chat.
  it('names the log, not the snapshot staged beside it', async () => {
    await writeRemnant('log.jsonl')
    await writeRemnant('snapshot.json')

    const journal = await open()

    expect(disclosure(journal)).toContain(join(root, 'log.jsonl'))
    expect(disclosure(journal)).not.toContain('snapshot.json')
  })

  it('falls back to the snapshot when a chat has no log beside it', async () => {
    await writeRemnant('snapshot.json')

    const journal = await open()

    expect(disclosure(journal)).toContain(join(root, 'snapshot.json'))
  })

  it('says nothing to a chat that is genuinely new', async () => {
    const journal = await open()

    expect(journal.snapshot().items).toEqual([])
  })

  // Counting rows proves nothing here — the append upserts by identity, so a
  // second append would still leave exactly one. The revision is what moves.
  it('does not re-append the row on a later open', async () => {
    await writeRemnant()
    const first = await open()
    const firstRevision = first
      .snapshot()
      .items.find((e) => e.itemId === DISCLOSURE_ITEM_ID)?.revision
    await first.close()

    const reopened = await open()

    const row = reopened.snapshot().items.find((e) => e.itemId === DISCLOSURE_ITEM_ID)
    expect(firstRevision).toBe(1)
    expect(row?.revision).toBe(1)
    expect(reopened.cursor().sequence).toBe(2)
  })

  // The epoch commit and this append are separate transactions; if the append is
  // lost the epoch exists but holds nothing, and every later open takes the
  // adopt branch. The offer has to survive that.
  it('offers the message again when a committed epoch holds nothing', async () => {
    const founded = await open()
    await founded.close()
    await writeRemnant()

    const reopened = await open()

    expect(disclosure(reopened)).toContain(join(root, 'log.jsonl'))
  })

  // A repair's epoch is the marker that history was deleted and never rebuilt,
  // and any row that is not the repair's own disclosure retires it. Appending
  // here would silently stop the session ever asking the provider for that
  // history — with the journal still holding none.
  it('stays out of a journal this open just repaired', async () => {
    const journal = await open()
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'history' }] },
      { fence: 1 }
    )
    await journal.close()
    // Deleting the anchor leaves every row unanchored: replay keeps nothing, so
    // the repair publishes an empty `unreconcilable_prefix` epoch and — costing
    // no malformed row — appends no disclosure of its own. That is the one state
    // where this branch and a repair meet.
    const opened = openJournalDatabase(journalDatabaseFile(root))
    try {
      opened.db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(1)
    } finally {
      opened.db.close()
    }
    await writeRemnant()

    const repaired = await open()

    expect(disclosure(repaired)).toBeNull()
    // Still asking the provider for the history the repair dropped.
    expect(loadJournal(root, IDENTITY.sessionId)).toMatchObject({ corrupt: true })
  })

  // A latched journal loads empty, so it reaches the same branch — and an append
  // into one throws, which would make the session unopenable rather than read-only.
  it('writes nothing into a journal latched by a newer schema', async () => {
    const founded = await open()
    await founded.close()
    const db = new Database(journalDatabaseFile(root))
    try {
      db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
    } finally {
      db.close()
    }
    await writeRemnant()

    const latched = await open()

    expect(latched.isReadOnly).toBe(true)
    expect(disclosure(latched)).toBeNull()
  })

  // A row nothing projects is a row nobody reads.
  it('renders in the transcript as a system line', async () => {
    await writeRemnant()

    const journal = await open()

    const messages = projectStructuredItemsToNativeChat(journal.snapshot().items)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('system')
  })
})
