// An empty chat beside a pre-SQLite journal explains itself.
//
// The SQLite move shipped no importer, so a session whose history is a
// `log.jsonl` founds a fresh empty journal beside it and looks exactly like a
// chat created seconds ago. One status row is the difference.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { JOURNAL_FILE_FORMAT_REMNANT_DISCLOSURE_IDENTITY } from './journal-file-format-remnant'
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

  // A row nothing projects is a row nobody reads.
  it('renders in the transcript as a system line', async () => {
    await writeRemnant()

    const journal = await open()

    const messages = projectStructuredItemsToNativeChat(journal.snapshot().items)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('system')
  })
})
