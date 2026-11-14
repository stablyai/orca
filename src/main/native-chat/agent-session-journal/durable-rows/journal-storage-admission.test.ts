import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../store-lifecycle/journal-host-database-test-support'
import { restoreJournal } from '../replay/journal-open'

// Admission keeps the in-memory chat within what this build declares on every path a saved value
// takes into it, so restating that chat on a new epoch never drops a newer build's key.

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

let root: string
let clock = 1_000
const inputs = createTrackedJournalOpener({ legacyInputs: true })
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-storage-admission-'))
})
afterEach(async () => {
  await inputs.closeAll()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function open(opener: typeof journals) {
  return opener.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${clock}`
  })
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

async function writeItems(opener: typeof journals, ordinals: number[]): Promise<string> {
  const journal = await open(opener)
  for (const ordinal of ordinals) {
    await journal.appendItem(
      item(ordinal),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `item ${ordinal}` }] },
      SCOPE
    )
  }
  await opener.closeAll()
  return journal.epoch
}

const db = () => openTestJournalHostDatabase(root).db

/** Every saved byte of the chat database: a refusal writes none of it. */
function savedBytes(): unknown {
  const tables = db()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map(({ name }) => String(name))
  return tables.map((table) => [table, db().prepare(`SELECT * FROM "${table}"`).all()])
}

/** Adds a key no build declares inside an item's first text block, as a newer build would. */
function withLaterKey(json: string): string {
  return json.replace('"type":"text",', '"type":"text","emphasis":"strong",')
}

it("refuses a newer build's record with an undeclared nested key before adopting it, writes nothing, and starts no epoch", async () => {
  await writeItems(journals, [0, 1, 2])
  const database = openTestJournalHostDatabase(root)
  const source = db().prepare('SELECT generation, through_seq FROM journal_outcome_epochs').get()
  const generation = Number(source?.generation)
  const through = Number(source?.through_seq)
  expect(restoreJournal(db(), IDENTITY.sessionId)).toMatchObject({ newer: null, damage: null })

  // The newer build revises item 2 with a key this build does not declare.
  const itemId = 'codex:thread-1:turn-1:2'
  const latest = db()
    .prepare(`SELECT value_json FROM journal_outcomes WHERE field = 'items' AND entry_key = ?
      ORDER BY seq DESC LIMIT 1`)
    .get(JSON.stringify(itemId))
  const revised = withLaterKey(String(latest?.value_json))
  const next = through + 1
  const ordinal = (index: number) =>
    `s${String(next).padStart(16, '0')}:${String(index).padStart(16, '0')}`
  database.transaction((write) => {
    const insert = write.prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, ?, ?, ?, 1, ?, ?, 0)`)
    insert.run(generation, next, 'items', JSON.stringify(itemId), ordinal(0), revised)
    write.prepare('UPDATE journal_outcome_epochs SET through_seq = ?').run(next)
  })
  const before = savedBytes()

  expect(restoreJournal(db(), IDENTITY.sessionId)).toMatchObject({ newer: { sequence: 1 } })
  // No handle exists for a refused chat, so nothing can replace, roll over or rewind its epoch.
  await expect(open(journals)).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
  expect(savedBytes()).toEqual(before)
})
z.object({
  sessionId: z.string(),
  epoch: z.string(),
  rows: z.array(z.string()),
  expected: z.record(z.string(), z.unknown())
}).parse(
  JSON.parse(
    readFileSync(
      new URL('../input-order/__fixtures__/journal-input-prefix.json', import.meta.url),
      'utf8'
    )
  )
)
