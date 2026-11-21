import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'

const SEEN_AT = 1_700_000_000_000

it('reparses only Grok rows cached before the synthetic-turn filter, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-parse-cache-grok-'))
  try {
    const path = join(dir, 'session-parse-cache.sqlite')
    const grokPath = join(dir, 'grok', 'session-1', 'summary.json')
    const claudePath = join(dir, 'claude', 'session-1.jsonl')
    const entry: PersistedSessionParseCacheEntry = {
      mtimeMs: 1,
      sizeBytes: 1,
      platform: 'linux',
      session: null
    }
    const cache = new SessionParseCacheDatabase(path)
    cache.write(
      [
        [grokPath, entry],
        [claudePath, entry]
      ],
      SEEN_AT
    )
    cache.close()
    const raw = new SyncDatabase(path)
    raw.prepare("DELETE FROM meta WHERE key = 'grok_rows_version'").run()
    raw.close()

    const upgraded = new SessionParseCacheDatabase(path)
    expect(upgraded.read(grokPath)).toBeUndefined()
    expect(upgraded.read(claudePath)).toBeDefined()
    upgraded.write([[grokPath, entry]], SEEN_AT)
    upgraded.close()

    const reopened = new SessionParseCacheDatabase(path)
    expect(reopened.read(grokPath)).toBeDefined()
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
