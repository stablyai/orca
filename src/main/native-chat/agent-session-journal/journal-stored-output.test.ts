import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { runJournalTransaction } from './database/journal-database'
import { readJournalDomainItems } from './journal-sql-item-reads'
import {
  readJournalDomainClientForms,
  readJournalDomainItemDetail
} from './journal-domain-item-presentation'
import { compactJournalStoredOutputPage } from './journal-stored-output-compaction'
import { measureJournalStoredRow } from './journal-stored-output-rows'
import type * as StoredOutput from './journal-stored-output'

const switches = vi.hoisted(() => ({ writes: true }))
vi.mock('./journal-stored-output', async (load) => {
  const actual = await load<typeof StoredOutput>()
  return {
    ...actual,
    get JOURNAL_STORED_OUTPUT_WRITES() {
      return switches.writes
    }
  }
})

const target = { sessionId: 'chat', epoch: 'epoch' }
// Past the 16 KiB client head, with text UTF-8 cannot carry unescaped (a lone surrogate).
const OUTPUT = `${'a'.repeat(20_000)}é\ud800 tail ${'line\n'.repeat(4_000)}`
const databases: Database.Database[] = []
afterEach(() => {
  switches.writes = true
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function chat() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,900,1)`
  ).run(target.sessionId, target.epoch)
  return db
}

function toolCall(
  itemId: string,
  state: 'running' | 'completed',
  revision = 1
): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: 10,
    observedAt: 1,
    body: {
      kind: 'tool-call',
      name: 'shell',
      callId: itemId,
      input: { command: 'cat big.log' },
      state,
      output: { head: OUTPUT, byteLength: 40_011, digest: 'd', truncated: false }
    }
  }
}

function write(db: Database.Database, item: AgentJournalRenderItem) {
  runJournalTransaction(db, () =>
    writeJournalDomainCurrentItem(db, target, { item, hidden: false, ownerFence: 1 })
  )
}

function stored(db: Database.Database, itemId: string) {
  return db
    .prepare(`SELECT output_blob IS NOT NULL AS blob FROM journal_items WHERE item_id=?`)
    .get(itemId)
}

function readTool(db: Database.Database) {
  const read = readJournalDomainItems(db, target, {
    kind: 'items-by-kind',
    kinds: ['tool-call'],
    afterOrdinal: 0,
    limit: 10
  })
  return read.kind === 'items-by-kind' ? read.items : []
}

it('reads a saved tool output back whole, as the bounded client head, through rewrites and with writes off', () => {
  const db = chat()
  write(db, toolCall('tool', 'completed'))
  expect(stored(db, 'tool')!.blob).toBe(1)
  // A tool-output page counts a stored row at its full size, not its preview's.
  const row = db.prepare(`SELECT payload_json, output_blob FROM journal_items`).get()!
  expect(measureJournalStoredRow(db, [target.sessionId, target.epoch], row).bytes).toBeGreaterThan(
    40_011
  )

  const [whole] = readTool(db)
  expect(whole!.body).toMatchObject({ output: { head: OUTPUT, truncated: false } })
  expect(readJournalDomainItemDetail(db, target, 'tool')!.body).toMatchObject({
    output: { head: OUTPUT, truncated: false }
  })
  const client = readJournalDomainClientForms(db, target, ['tool']).get('tool')!
  expect(client.item.body).toEqual({
    kind: 'tool-call',
    name: 'shell',
    callId: 'tool',
    input: { command: 'cat big.log' },
    state: 'completed',
    output: { head: 'a'.repeat(16_384), byteLength: 40_011, digest: 'd', truncated: true }
  })

  expect(client.bytes).toBeGreaterThan(16_384)

  // A later revision written from the hydrated read keeps every byte.
  write(db, { ...whole!, revision: 2 })
  // A row form that never hydrated keeps this row's blob; it cannot name another row's.
  const raw: AgentJournalRenderItem = JSON.parse(
    String(
      db.prepare(`SELECT payload_json FROM journal_items WHERE item_id='tool'`).get()!.payload_json
    )
  )
  write(db, { ...raw, revision: 3 })
  expect(readTool(db)[0]!.body).toMatchObject({ output: { head: OUTPUT, truncated: false } })
  expect(readJournalDomainClientForms(db, target, ['tool']).get('tool')!.bytes).toBe(client.bytes)
  // A stored form copied to a row without its blob keeps the preview as a plain truncated output.
  write(db, { ...raw, itemId: 'other', sequence: 11 })
  const copy = readJournalDomainItemDetail(db, target, 'other')!.body
  expect(copy.kind === 'tool-call' && copy.output).toEqual({
    head: `${OUTPUT.slice(0, 512)}\n…\n${OUTPUT.slice(-512)}`,
    byteLength: 40_011,
    digest: 'd',
    truncated: true
  })

  // With writes off, a rewrite stores the whole text inline again.
  switches.writes = false
  const tool = () => readTool(db).find((item) => item.itemId === 'tool')!
  write(db, { ...tool(), revision: 4 })
  expect(stored(db, 'tool')!.blob).toBe(0)
  expect(tool().body).toMatchObject({ output: { head: OUTPUT, truncated: false } })
})

it('compacts inline rows written before the switch, leaving running calls inline', () => {
  const db = chat()
  switches.writes = false
  write(db, toolCall('done', 'completed'))
  write(db, { ...toolCall('live', 'running'), sequence: 11 })
  expect(stored(db, 'done')!.blob).toBe(0)

  switches.writes = true
  while (compactJournalStoredOutputPage(db).more) {
    // Pages until the pass reaches the last row.
  }
  expect(stored(db, 'done')!.blob).toBe(1)
  expect(stored(db, 'live')!.blob).toBe(0)
  expect(readTool(db).map((item) => item.body)).toMatchObject([
    { state: 'completed', output: { head: OUTPUT, truncated: false } },
    { state: 'running' }
  ])
})
