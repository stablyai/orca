import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionParseCacheDatabase } from './session-parse-cache-database'

it('adds the fingerprint to old cache databases without losing existing sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-kimi-cache-'))
  const path = join(root, 'cache.sqlite')
  try {
    const original = new SessionParseCacheDatabase(path)
    const retained = { mtimeMs: 1, sizeBytes: 4, platform: 'darwin' as const, session: null }
    original.write([['retained', retained]], 1)
    original.close()

    const oldSchema = new SyncDatabase(path)
    oldSchema.exec('ALTER TABLE rows DROP COLUMN content_fingerprint')
    oldSchema.close()

    const upgraded = new SessionParseCacheDatabase(path)
    expect(upgraded.read('retained')).toEqual(retained)
    upgraded.write([['kimi', { ...retained, contentFingerprint: 'kimi-v2-1:fixture' }]], 2)
    upgraded.close()

    const reopened = new SessionParseCacheDatabase(path)
    expect(reopened.read('retained')).toEqual(retained)
    expect(reopened.read('kimi')?.contentFingerprint).toBe('kimi-v2-1:fixture')
    reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
