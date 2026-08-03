import { beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  resetSessionParseCacheForTests,
  seedSessionParseCache,
  type PersistedSessionParseCacheEntry
} from './session-scanner-parse-cache'
import { cachedOpenCodeSqliteCandidates } from './session-scanner-opencode-sqlite-cached-candidates'

function cacheEntry(
  path: string,
  sessionId: string,
  mtimeMs: number
): PersistedSessionParseCacheEntry {
  const session: AiVaultSession = {
    id: `local:opencode:${sessionId}:${path}`,
    executionHostId: 'local',
    agent: 'opencode',
    sessionId,
    title: sessionId,
    cwd: null,
    branch: null,
    model: null,
    filePath: path,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: new Date(mtimeMs).toISOString(),
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `opencode --session ${sessionId}`,
    subagent: null
  }
  return { mtimeMs, sizeBytes: null, platform: 'darwin', session }
}

describe('cachedOpenCodeSqliteCandidates', () => {
  beforeEach(() => resetSessionParseCacheForTests())

  it('deduplicates DB aliases by session id before applying the limit', () => {
    const canonicalDb = '/data/opencode.db'
    const backupDb = '/data/opencode-backup.db'
    seedSessionParseCache([
      [`${backupDb}#same`, cacheEntry(`${backupDb}#same`, 'same', 10)],
      [`${canonicalDb}#same`, cacheEntry(`${canonicalDb}#same`, 'same', 20)],
      [`${canonicalDb}#unique`, cacheEntry(`${canonicalDb}#unique`, 'unique', 15)]
    ])

    expect(
      cachedOpenCodeSqliteCandidates({
        dbPaths: [canonicalDb, backupDb],
        platform: 'darwin',
        limit: 2
      }).map((candidate) => candidate.file.path)
    ).toEqual([`${canonicalDb}#same`, `${canonicalDb}#unique`])
  })

  it('uses DB path order to break equal-mtime alias ties', () => {
    const canonicalDb = '/data/opencode.db'
    const backupDb = '/data/opencode-backup.db'
    seedSessionParseCache([
      [`${backupDb}#same`, cacheEntry(`${backupDb}#same`, 'same', 20)],
      [`${canonicalDb}#same`, cacheEntry(`${canonicalDb}#same`, 'same', 20)]
    ])

    expect(
      cachedOpenCodeSqliteCandidates({
        dbPaths: [canonicalDb, backupDb],
        platform: 'darwin',
        limit: 10
      }).map((candidate) => candidate.file.path)
    ).toEqual([`${canonicalDb}#same`])
  })
})
