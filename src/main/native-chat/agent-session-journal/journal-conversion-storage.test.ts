import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './database/journal-host-database'
import { measureJournalConversionStorage } from './journal-conversion-storage'
import { olderOrcaChat } from './journal-legacy-retirement.test-fixture'
import { journalLegacyCopySourceKey } from './database/journal-legacy-source'

const statfs = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  statfs
}))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('counts only blocks this user may write, not those reserved for root', async () => {
  statfs.mockResolvedValue({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 100 })
  const db = new Database(':memory:')
  await expect(measureJournalConversionStorage('/journal', db, db)).resolves.toEqual({
    freeBytes: 100 * 4096,
    totalBytes: 1000 * 4096
  })
  db.close()
})

it('estimates one chat from its own bytes, so other chats and newer store chats change nothing', async () => {
  statfs.mockResolvedValue({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 100 })
  const root = mkdtempSync(join(tmpdir(), 'orca-conversion-storage-'))
  roots.push(root)
  const filename = journalDatabasePath(root)
  olderOrcaChat(filename, 'unopened')
  olderOrcaChat(filename, 'other')
  const legacy = new Database(filename)
  // Multi-byte text: three bytes per CJK character, four per emoji.
  legacy
    .prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)')
    .run('unopened', 'epoch', 9999, 0, JSON.stringify({ text: '漢字🙂'.repeat(1000) }))
  const bytes = legacy
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=?')
    .all('unopened')
    .reduce((sum, row) => sum + Buffer.byteLength(String(row.row_json)), 0)
  legacy.close()
  const source = new Database(filename, { readonly: true })
  const store = new Database(':memory:')
  store.exec('CREATE TABLE agent_session_store_meta(key TEXT PRIMARY KEY, value TEXT)')
  const before = await measureJournalConversionStorage(filename, source, store, 'unopened')
  store.exec('CREATE TABLE chats(id TEXT, body TEXT)')
  store.prepare('INSERT INTO chats VALUES(?,?)').run('newer', 'x'.repeat(1_000_000))
  store
    .prepare('INSERT INTO agent_session_store_meta VALUES(?,?)')
    .run(journalLegacyCopySourceKey('copy'), 'unopened')
  const after = await measureJournalConversionStorage(filename, source, store, 'unopened')
  const copy = await measureJournalConversionStorage(filename, source, store, 'copy')
  source.close()
  store.close()
  expect(before.remainingBytes).toBe(bytes)
  expect(after).toEqual(before)
  // A copy converts from its original chat, so it needs the original's bytes.
  expect(copy).toEqual(before)
})
