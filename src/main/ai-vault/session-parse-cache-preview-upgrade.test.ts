import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import {
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

let root: string | undefined

afterEach(async () => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('reparses unchanged transcripts whose cached previews included reasoning', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-preview-upgrade-'))
  const path = join(root, 'session.jsonl')
  const records = [
    { type: 'user', sessionId: 'preview-upgrade', message: { content: 'Question' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', text: 'Internal reasoning' },
          { type: 'text', text: 'Visible answer' }
        ]
      }
    }
  ]
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const fileStat = await stat(path)
  const candidate: SessionFileCandidate = {
    agent: 'claude',
    codexHome: null,
    file: {
      path,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size
    }
  }
  await parseAgentSessionFileCached(candidate, process.platform)
  const entry = getSessionParseCacheEntry(path)
  if (!entry?.session) {
    throw new Error('Expected parsed session')
  }
  const dbPath = join(root, 'session-parse-cache.sqlite')
  const cache = new SessionParseCacheDatabase(dbPath)
  try {
    cache.write(
      [
        [
          path,
          {
            ...entry,
            session: {
              ...entry.session,
              previewMessages: [
                { role: 'assistant', text: 'Internal reasoning Visible answer', timestamp: null }
              ]
            }
          }
        ]
      ],
      Date.now()
    )
  } finally {
    cache.close()
  }
  const oldDatabase = new SyncDatabase(dbPath)
  try {
    oldDatabase.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run()
  } finally {
    oldDatabase.close()
  }
  resetSessionParseCacheForTests()
  initSessionParseCachePersistence({ filePath: join(root, 'cache.json'), appVersion: 'new' })

  const stats = createSessionParseStats()
  const session = await parseAgentSessionFileCached(candidate, process.platform, stats)

  expect(stats.fullParses).toBe(1)
  expect(stats.reused).toBe(0)
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'Question',
    'Visible answer'
  ])
})
