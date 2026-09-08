import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from '../sqlite/sync-database'
import { searchPresentSessionSources } from './session-search-source-presence'
import type { AiVaultSearchHit, AiVaultSearchResult } from '../../shared/ai-vault-search-types'

function searchSources(result: AiVaultSearchResult, invalidate: (paths: string[]) => void) {
  return searchPresentSessionSources({ query: 'fixture', limit: 100 }, () => result, invalidate)
}

it('checks individual OpenCode identities when several sessions share one database file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-search-source-'))
  try {
    const filePath = join(root, 'opencode.db')
    const database = new Database(filePath)
    database.exec(
      "CREATE TABLE session(id TEXT PRIMARY KEY, time_archived INTEGER); INSERT INTO session VALUES ('live',NULL),('archived',123)"
    )
    database.close()
    const hit = (sessionId: string): AiVaultSearchHit => ({
      agent: 'opencode',
      filePath,
      sessionId,
      title: 'synthetic',
      cwd: root,
      codexHome: null,
      branch: null,
      updatedAt: null,
      messageCount: 1,
      resumeCommand: 'opencode',
      score: 0,
      evidence: { role: 'user', timestamp: null, snippet: 'owned fixture' }
    })
    const result: AiVaultSearchResult = {
      hits: [hit('live'), hit('removed'), hit('archived')],
      route: 'phrase',
      durationMs: 0,
      coverage: {
        sessionsIndexed: 3,
        messagesIndexed: 3,
        providers: [],
        backfill: 'complete',
        filesPending: 0,
        lastIndexedAt: null
      }
    }
    const invalidate = vi.fn()
    expect((await searchSources(result, invalidate)).hits.map((value) => value.sessionId)).toEqual([
      'live'
    ])
    expect(invalidate.mock.calls).toEqual([[[`${filePath}#removed`]], [[`${filePath}#archived`]]])
    await rm(filePath)
    expect((await searchSources(result, invalidate)).hits).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps unreadable sources as hits and flags them instead of dropping them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-search-unreadable-'))
  try {
    const filePath = join(root, 'opencode.db')
    const database = new Database(filePath)
    database.exec('CREATE TABLE unexpected_schema(id TEXT)')
    database.close()
    const invalidate = vi.fn()
    const result = await searchSources(
      {
        hits: [{ agent: 'opencode', filePath, sessionId: 'fixture' } as AiVaultSearchHit],
        coverage: {}
      } as AiVaultSearchResult,
      invalidate
    )
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['fixture'])
    expect(result).toMatchObject({ sourceUnavailableFiles: 1 })
    expect(invalidate).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
