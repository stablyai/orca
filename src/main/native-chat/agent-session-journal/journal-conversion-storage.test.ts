import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './database/journal-host-database'
import { measureJournalConversionStorage } from './journal-conversion-storage'
import { olderOrcaChat } from './journal-legacy-retirement.test-fixture'

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
  await expect(measureJournalConversionStorage('/journal', db, false)).resolves.toEqual({
    freeBytes: 100 * 4096,
    totalBytes: 1000 * 4096
  })
  db.close()
})

it('estimates from the original alone, so newer chats only in the new store change nothing', async () => {
  statfs.mockResolvedValue({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 100 })
  const root = mkdtempSync(join(tmpdir(), 'orca-conversion-storage-'))
  roots.push(root)
  const filename = journalDatabasePath(root)
  olderOrcaChat(filename, 'unopened')
  const source = new Database(filename, { readonly: true })
  const size =
    Number(source.pragma('page_count', { simple: true })) *
    Number(source.pragma('page_size', { simple: true }))
  const before = await measureJournalConversionStorage(filename, source, true)
  const store = new Database(join(root, 'store.sqlite'))
  store.exec('CREATE TABLE chats(id TEXT, body TEXT)')
  store.prepare('INSERT INTO chats VALUES(?,?)').run('newer', 'x'.repeat(1_000_000))
  store.close()
  const after = await measureJournalConversionStorage(filename, source, true)
  source.close()
  expect(before.remainingBytes).toBe(size)
  expect(after).toEqual(before)
})
