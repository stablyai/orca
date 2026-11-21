import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { historySession } from '../structured-sessions/structured-session-ownership.test-support'

const SEEN_AT = 1_700_000_000_000

it('reparses only rows cached before a parser fix, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-parse-cache-repair-'))
  try {
    const path = join(dir, 'session-parse-cache.sqlite')
    const grokPath = join(dir, 'grok', 'session-1', 'summary.json')
    const piPath = join(dir, 'pi', 'session-1.jsonl')
    const codexPath = join(dir, 'codex', 'session-1.jsonl')
    const entry = (session: AiVaultSession | null): PersistedSessionParseCacheEntry => ({
      mtimeMs: 1,
      sizeBytes: 1,
      platform: 'linux',
      session
    })
    const cache = new SessionParseCacheDatabase(path)
    cache.write(
      [
        [grokPath, entry(null)],
        [piPath, entry(historySession({ agent: 'pi' }))],
        [codexPath, entry(historySession())]
      ],
      SEEN_AT
    )
    cache.close()
    const raw = new SyncDatabase(path)
    raw
      .prepare("DELETE FROM meta WHERE key IN ('grok_rows_version', 'pi_title_rows_version')")
      .run()
    raw.close()

    const upgraded = new SessionParseCacheDatabase(path)
    expect(upgraded.read(grokPath)).toBeUndefined()
    expect(upgraded.read(piPath)).toBeUndefined()
    expect(upgraded.read(codexPath)).toBeDefined()
    upgraded.write([[piPath, entry(historySession({ agent: 'pi' }))]], SEEN_AT)
    upgraded.close()

    const reopened = new SessionParseCacheDatabase(path)
    expect(reopened.read(piPath)).toBeDefined()
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
