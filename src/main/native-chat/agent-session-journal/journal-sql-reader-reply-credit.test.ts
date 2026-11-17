import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  ensureWorkerSendLedger,
  readWorkerSendLedger
} from '../../worker-threads/worker-send-ledger'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { JournalSqlOwner } from './journal-sql-owner'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'
import { message } from './journal-sql-message.test-fixture'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'

const MB = 2 ** 20
const ITEM_BYTES = 6 * MB
const ITEMS = 12

let root: string | undefined
let owner: JournalSqlOwner | undefined
let pool: JournalSqlReaderPool | undefined

afterEach(async () => {
  await pool?.close()
  await owner?.close()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function chatWithLargeItems(): Promise<{ filename: string; itemIds: string[] }> {
  root = await mkdtemp(join(tmpdir(), 'journal-reply-credit-'))
  const filename = join(root, 'journal.db')
  const { db } = openJournalDomainDatabase(filename)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace','session','epoch',1,1)`
  ).run()
  db.close()
  owner = new JournalSqlOwner(filename, root, journalSqlWorkerPath())
  await owner.opened()
  for (let index = 0; index < ITEMS; index++) {
    const step = message(String(index).padEnd(ITEM_BYTES, 'x'), `assistant-${index}`)
    await owner.write({
      target: { sessionId: 'session', epoch: 'epoch', ownerToken: 'open-token' },
      savedAt: 100 + index,
      operation: {
        kind: 'steps',
        steps: [
          {
            kind: 'resolved-item',
            reservedBytes: 1024,
            resolution: { kind: 'text-snapshot', identity: step.identity, body: step.body },
            options: step.options
          }
        ]
      }
    })
  }
  const probe = new Database(filename, { readonly: true })
  const itemIds = probe
    .prepare(`SELECT item_id FROM journal_items WHERE session_id='session' AND hidden=0`)
    .all()
    .map((row) => String((row as { item_id: unknown }).item_id))
  probe.close()
  return { filename, itemIds }
}

const readerBytesPosted = (): number =>
  readWorkerSendLedger()
    .filter((slot) => slot.role === 'orca-journal-sql-reader')
    .reduce((total, slot) => total + slot.producedBytes, 0)

it('holds large replies in their readers while main has not consumed the budget', async () => {
  const { filename, itemIds } = await chatWithLargeItems()
  expect(itemIds).toHaveLength(ITEMS)
  ensureWorkerSendLedger()
  pool = new JournalSqlReaderPool(filename, filename, journalSqlReaderPath())
  const readers = pool
  // Warm all four readers so none starts cold inside a measured window.
  await Promise.all(
    Array.from({ length: 4 }, () => readers.database({ kind: 'epoch', sessionId: 'session' }))
  )
  const before = readerBytesPosted()
  let consumed = 0
  const reads = itemIds.map((itemId) =>
    readers.point({ sessionId: 'session', operation: { kind: 'item', itemId } }).then(() => {
      consumed += ITEM_BYTES
    })
  )
  let maxUnconsumed = 0
  while (consumed < ITEMS * ITEM_BYTES) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Main is busy while the readers keep answering.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    maxUnconsumed = Math.max(maxUnconsumed, readerBytesPosted() - before - consumed)
  }
  await Promise.all(reads)
  const sample = await readers.point({
    sessionId: 'session',
    operation: { kind: 'item', itemId: itemIds[0]! }
  })
  expect(JSON.stringify(sample).length).toBeGreaterThan(ITEM_BYTES)
  // Eight admitted reads of 6 MB would post 48 MB; the 64 MB charge (UTF-16 width) stops near 32 MB.
  expect(maxUnconsumed).toBeLessThanOrEqual(33 * MB)
})
