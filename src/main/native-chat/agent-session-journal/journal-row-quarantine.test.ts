// A repair copies the rows it rejects before it drops them.
//
// The rejected row and every valid row behind it are the only copy of what the
// session wrote after the fault — a submission receipt among them, which no
// provider transcript can rebuild. These assert the copy exists, byte for byte,
// and that a repair which cannot write one does not delete anything.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import { journalQuarantineDirectory } from './journal-row-quarantine'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const CORRUPT_ROW = '}{ not a row λ'

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function open() {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
}

async function withJournalDatabase<T>(run: (db: Database.Database) => T): Promise<T> {
  const opened = openJournalDatabase(journalDatabaseFile(root))
  try {
    return run(opened.db)
  } finally {
    opened.db.close()
  }
}

function storedRows(db: Database.Database): { seq: number; row_json: string }[] {
  return db.prepare('SELECT seq, row_json FROM journal_rows ORDER BY seq').all() as {
    seq: number
    row_json: string
  }[]
}

type QuarantinedRow = { epoch: string; seq: number; ts: number; rowJson: string }

async function quarantinedRows(): Promise<QuarantinedRow[]> {
  const directory = journalQuarantineDirectory(root)
  const files = await readdir(directory)
  expect(files).toHaveLength(1)
  const contents = await readFile(join(directory, files[0]!), 'utf8')
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as QuarantinedRow)
}

/** A prefix, a row this build cannot parse, and valid rows behind it — one of
 *  them an Orca-minted submission receipt. */
async function seedCorruptedJournal(): Promise<void> {
  const journal = await open()
  await journal.appendItem(item(0), body('readable prefix'), { fence: 1 })
  await journal.appendItem(item(1), body('the fault'), { fence: 1 })
  await journal.appendSubmission({
    clientMessageId: 'orca-only-receipt',
    payloadFingerprint: 'fingerprint',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'only in Orca' }] }
  })
  await journal.appendItem(item(2), body('valid suffix'), { fence: 1 })
  await journal.close()
  // Sequence 1 is the epoch row, so the fault lands at 3 and 4..5 are valid.
  await withJournalDatabase((db) => {
    db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run(CORRUPT_ROW, 3)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-quarantine-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('quarantines the rejected row and every valid row behind it, byte for byte', async () => {
  await seedCorruptedJournal()
  const before = await withJournalDatabase(storedRows)

  const reopened = await open()
  expect(reopened.repair.malformedRows).toBe(1)

  const quarantined = await quarantinedRows()
  expect(quarantined.map((row) => row.seq)).toEqual([3, 4, 5])
  // The exact stored bytes, including the row that is not valid JSON.
  expect(quarantined.map((row) => row.rowJson)).toEqual(
    before.filter((row) => row.seq >= 3).map((row) => row.row_json)
  )
  expect(quarantined[0]?.rowJson).toBe(CORRUPT_ROW)
  // The Orca-only submission receipt no provider transcript can rebuild.
  expect(quarantined.some((row) => row.rowJson.includes('orca-only-receipt'))).toBe(true)
  const sourceEpoch = before[0]?.row_json ?? ''
  expect(quarantined.every((row) => sourceEpoch.includes(row.epoch))).toBe(true)
})

it('drops nothing and latches read-only when the copy cannot be written', async () => {
  await seedCorruptedJournal()
  const before = await withJournalDatabase(storedRows)
  // A plain file where the quarantine directory has to go, so `mkdir` fails.
  // Chosen over a permission bit because that would be a no-op on Windows.
  await writeFile(journalQuarantineDirectory(root), 'not a directory')

  const reopened = await open()

  expect(reopened.isReadOnly).toBe(true)
  await expect(reopened.appendItem(item(9), body('refused'))).rejects.toMatchObject({
    code: 'journal_read_only'
  })
  // Every row the repair would have deleted is still there, unchanged.
  expect(await withJournalDatabase(storedRows)).toEqual(before)
})

it('quarantines the rows a sequence gap orphans, which carry no malformed row', async () => {
  const journal = await open()
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    await journal.appendItem(item(ordinal), body(`m${ordinal}`), { fence: 1 })
  }
  await journal.close()
  // Items occupy 2..6; removing 4 leaves 5 and 6 valid but unanchored.
  await withJournalDatabase((db) => {
    db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(4)
  })
  const before = await withJournalDatabase(storedRows)

  await open()

  const quarantined = await quarantinedRows()
  expect(quarantined.map((row) => row.seq)).toEqual([5, 6])
  expect(quarantined.map((row) => row.rowJson)).toEqual(
    before.filter((row) => row.seq >= 5).map((row) => row.row_json)
  )
})
