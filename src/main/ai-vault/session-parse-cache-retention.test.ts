import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  AI_VAULT_PARSE_CACHE_KEY_MAX_UTF8_BYTES,
  AI_VAULT_PARSE_CACHE_VALUE_MAX_UTF8_BYTES,
  inspectSessionParseCacheRetentionForTests,
  resetSessionParseCacheRetentionForTests,
  seedSessionParseCache,
  setSessionParseCacheMaxRetainedBytesForTests,
  snapshotSessionParseCacheForPersistence,
  storeSessionParseCacheEntry,
  type PersistedSessionParseCacheEntry,
  type SessionParseCacheEntry
} from './session-parse-cache-retention'
import type { ResumableSessionParseState } from './session-scanner-types'

beforeEach(() => resetSessionParseCacheRetentionForTests())
afterEach(() => resetSessionParseCacheRetentionForTests())

function persistedEntry(model: string | null = null): PersistedSessionParseCacheEntry {
  return {
    mtimeMs: 1,
    sizeBytes: 2,
    platform: process.platform,
    session: session(model)
  }
}

function cacheEntry(model: string | null = null): SessionParseCacheEntry {
  return { ...persistedEntry(model), resume: null }
}

function cacheEntryWithResumeBytes(bytes: number): SessionParseCacheEntry {
  let state: ResumableSessionParseState
  state = {
    consumeLine: () => {},
    clone: () => state,
    retainedUtf8Bytes: () => bytes,
    touchFile: () => {},
    finalize: () => null
  }
  return { ...persistedEntry(), resume: { state, byteOffset: 0 } }
}

function session(model: string | null): AiVaultSession {
  return {
    id: 'local:claude:session:/transcript',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session',
    title: 'Title',
    cwd: '/repo',
    branch: 'main',
    model,
    filePath: '/transcript',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 1,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume session',
    subagent: null
  }
}

function entryWithSerializedBytes(targetBytes: number): PersistedSessionParseCacheEntry {
  const entry = persistedEntry('')
  const baseBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
  expect(baseBytes).toBeLessThan(targetBytes)
  entry.session!.model = 'x'.repeat(targetBytes - baseBytes)
  expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBe(targetBytes)
  return entry
}

function retainedBytes(path: string, entry: PersistedSessionParseCacheEntry): number {
  return Buffer.byteLength(path, 'utf8') + Buffer.byteLength(JSON.stringify(entry), 'utf8')
}

describe('session parse cache retention', () => {
  it('admits an exact-limit UTF-8 key and rejects one byte over', () => {
    const exact = 'é'.repeat(AI_VAULT_PARSE_CACHE_KEY_MAX_UTF8_BYTES / 2)
    const overflow = `${exact}x`
    expect(Buffer.byteLength(exact, 'utf8')).toBe(AI_VAULT_PARSE_CACHE_KEY_MAX_UTF8_BYTES)

    seedSessionParseCache([
      [exact, persistedEntry()],
      [overflow, persistedEntry()]
    ])

    expect(snapshotSessionParseCacheForPersistence().map(([path]) => path)).toEqual([exact])
  })

  it('admits an exact-limit serialized value and rejects one byte over', () => {
    const exact = entryWithSerializedBytes(AI_VAULT_PARSE_CACHE_VALUE_MAX_UTF8_BYTES)
    const overflow = entryWithSerializedBytes(AI_VAULT_PARSE_CACHE_VALUE_MAX_UTF8_BYTES + 1)

    seedSessionParseCache([
      ['/exact', exact],
      ['/overflow', overflow]
    ])

    expect(snapshotSessionParseCacheForPersistence()).toEqual([['/exact', exact]])
  })

  it('includes the non-persisted resume fold in the exact value limit', () => {
    const persistedBytes = Buffer.byteLength(JSON.stringify(persistedEntry()), 'utf8')
    const exactResumeBytes = AI_VAULT_PARSE_CACHE_VALUE_MAX_UTF8_BYTES - persistedBytes

    storeSessionParseCacheEntry('/exact-resume', cacheEntryWithResumeBytes(exactResumeBytes))
    storeSessionParseCacheEntry('/overflow-resume', cacheEntryWithResumeBytes(exactResumeBytes + 1))

    expect(inspectSessionParseCacheRetentionForTests().paths).toEqual(['/exact-resume'])
  })

  it('fills the aggregate UTF-8 budget exactly and keeps the newest entries on overflow', () => {
    const first: [string, PersistedSessionParseCacheEntry] = ['/a', persistedEntry()]
    const second: [string, PersistedSessionParseCacheEntry] = ['/b', persistedEntry()]
    const exactBytes = retainedBytes(...first) + retainedBytes(...second)
    setSessionParseCacheMaxRetainedBytesForTests(exactBytes)

    seedSessionParseCache([first, second])
    expect(inspectSessionParseCacheRetentionForTests()).toEqual({
      paths: ['/a', '/b'],
      retainedUtf8Bytes: exactBytes
    })

    setSessionParseCacheMaxRetainedBytesForTests(exactBytes - 1)
    seedSessionParseCache([first, second])
    expect(inspectSessionParseCacheRetentionForTests().paths).toEqual(['/b'])
  })

  it('refreshes LRU recency before aggregate eviction', () => {
    const persisted = persistedEntry()
    const entry = cacheEntry()
    const twoEntryBytes = retainedBytes('/a', persisted) + retainedBytes('/b', persisted)
    setSessionParseCacheMaxRetainedBytesForTests(twoEntryBytes)

    storeSessionParseCacheEntry('/a', entry)
    storeSessionParseCacheEntry('/b', entry)
    storeSessionParseCacheEntry('/a', entry)
    storeSessionParseCacheEntry('/c', entry)

    expect(inspectSessionParseCacheRetentionForTests().paths).toEqual(['/a', '/c'])
  })
})
