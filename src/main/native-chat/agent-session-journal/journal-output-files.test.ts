import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { runJournalTransaction } from './database/journal-database'
import { readJournalDomainItems } from './journal-sql-item-reads'
import { storeJournalItemOutput } from './journal-stored-output'
import {
  JOURNAL_OUTPUT_FILE_INDEX,
  JOURNAL_OUTPUT_FILE_SCHEMA,
  registerJournalOutputFileRoot
} from './journal-output-files'
import { journalOutputFilePath } from './journal-output-file-references'
import { sweepJournalOutputFiles } from './journal-output-file-sweep'

/** One whole sweep: every unit until the sweep says it is done. */
function sweepAll(db: Database.Database, now: number) {
  let removed = 0
  let freedBytes = 0
  for (;;) {
    const unit = sweepJournalOutputFiles(db, now)
    removed += unit.removed
    freedBytes += unit.freedBytes
    if (!unit.more) {
      return { removed, freedBytes }
    }
  }
}

const target = { sessionId: 'chat', epoch: 'epoch' }
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const run of cleanup.splice(0)) {
    run()
  }
})

function journal() {
  const root = mkdtempSync(join(tmpdir(), 'orca-output-files-'))
  const db = new Database(':memory:')
  cleanup.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  migrateJournalDomainSchema(db)
  db.exec(JOURNAL_OUTPUT_FILE_SCHEMA)
  db.exec(JOURNAL_OUTPUT_FILE_INDEX)
  registerJournalOutputFileRoot(db, root, true)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,9,1)`
  ).run(target.sessionId, target.epoch)
  const write = (item: AgentJournalRenderItem) =>
    runJournalTransaction(db, () =>
      writeJournalDomainCurrentItem(db, target, { item, ordinal: 1, hidden: false, ownerFence: 1 })
    )
  return { db, root, write }
}

it('stores a completed output over the detail size as a head beside its whole-text file', () => {
  const { db, root, write } = journal()
  const output = 'line of tool output é😀\n'.repeat(400_000)
  const tool = (revision: number): AgentJournalRenderItem => ({
    itemId: 'tool',
    revision,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'tool-call',
      name: 'Bash',
      input: {},
      state: 'completed',
      output: { head: output, byteLength: 10_800_000, digest: 'original', truncated: false }
    }
  })
  write(tool(1))

  const stored = db.prepare('SELECT payload_json FROM journal_items').get()!
  expect(String(stored.payload_json).length).toBeLessThan(4.2 * 1024 * 1024)
  const payload = JSON.parse(String(stored.payload_json)).body.output
  expect(payload).toMatchObject({
    byteLength: 10_800_000,
    digest: 'original',
    truncated: true
  })
  expect(output.startsWith(payload.head)).toBe(true)
  const path = journalOutputFilePath(root, payload.outputFile)
  expect(readFileSync(path, 'utf8')).toBe(output)
  // Exports stream the file in place of the row's head.
  expect(readJournalDomainItems(db, target, { kind: 'continuation-context' })).toMatchObject({
    context: {
      continued: [{ index: 0, itemId: 'tool', field: 'output', file: payload.outputFile }]
    }
  })

  // A later revision of the same whole output keeps pointing at the same file.
  write(tool(2))
  expect(
    JSON.parse(String(db.prepare('SELECT payload_json FROM journal_items').get()!.payload_json))
      .body.output.outputFile
  ).toBe(payload.outputFile)

  const day = 24 * 60 * 60 * 1000
  sweepAll(db, 0)
  sweepAll(db, 2 * day)
  expect(existsSync(path)).toBe(true)

  // A saved output blob would drop the file's name.
  const fileBacked: AgentJournalRenderItem = JSON.parse(
    String(db.prepare('SELECT payload_json FROM journal_items').get()!.payload_json)
  )
  expect(storeJournalItemOutput(fileBacked)).toBeNull()

  db.prepare('DELETE FROM journal_items').run()
  sweepAll(db, 3 * day)
  expect(existsSync(path)).toBe(true)
  // Named again, then dropped again: the grace starts over.
  write(tool(3))
  db.prepare('DELETE FROM journal_items').run()
  sweepAll(db, 4 * day)
  expect(existsSync(path)).toBe(true)
  sweepAll(db, 5 * day - 1)
  expect(existsSync(path)).toBe(true)
  expect(sweepAll(db, 5 * day)).toMatchObject({
    removed: 1,
    freedBytes: 10_800_000
  })
  expect(existsSync(path)).toBe(false)
})
