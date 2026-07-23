import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  AI_VAULT_PARSE_CACHE_APP_VERSION_MAX_JSON_BYTES,
  AI_VAULT_PARSE_CACHE_PERSIST_MAX_UTF8_BYTES,
  serializeSessionParseCachePayload
} from './session-parse-cache-payload'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-retention'
import { AI_VAULT_WHOLE_JSON_MAX_BYTES } from './session-whole-json-reader'

function entry(model: string | null = null): PersistedSessionParseCacheEntry {
  return {
    mtimeMs: 1,
    sizeBytes: 2,
    platform: process.platform,
    session: session(model)
  }
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

describe('session parse cache payload', () => {
  it('is byte-identical to native JSON when every LRU entry fits', () => {
    const entries: [string, PersistedSessionParseCacheEntry][] = [
      ['/old\n✨', entry('first')],
      ['/new', entry('second')]
    ]
    const expected = JSON.stringify({ schemaVersion: 1, appVersion: '1.2.3', entries })

    expect(
      serializeSessionParseCachePayload({ schemaVersion: 1, appVersion: '1.2.3', entries })
    ).toBe(expected)
  })

  it('uses the exact byte boundary and prioritizes newest LRU entries', () => {
    const older: [string, PersistedSessionParseCacheEntry] = ['/older', entry('x'.repeat(200))]
    const middle: [string, PersistedSessionParseCacheEntry] = ['/middle', entry('middle')]
    const newest: [string, PersistedSessionParseCacheEntry] = ['/newest', entry('newest')]
    const expected = JSON.stringify({
      schemaVersion: 1,
      appVersion: '1.2.3',
      entries: [middle, newest]
    })
    const exactBytes = Buffer.byteLength(expected, 'utf8')

    const exact = serializeSessionParseCachePayload({
      schemaVersion: 1,
      appVersion: '1.2.3',
      entries: [older, middle, newest],
      maxBytes: exactBytes
    })
    expect(exact).toBe(expected)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(exactBytes)

    const overflow = JSON.parse(
      serializeSessionParseCachePayload({
        schemaVersion: 1,
        appVersion: '1.2.3',
        entries: [older, middle, newest],
        maxBytes: exactBytes - 1
      })
    ) as { entries: [string, PersistedSessionParseCacheEntry][] }
    expect(overflow.entries.map(([path]) => path)).toEqual(['/newest'])
  })

  it('caps production output below the 64 MiB reader ceiling', () => {
    const payload = serializeSessionParseCachePayload({
      schemaVersion: 1,
      appVersion: '1.2.3',
      entries: [['/too-large', entry('x'.repeat(1024 * 1024))]],
      maxBytes: 512
    })

    expect(JSON.parse(payload).entries).toEqual([])
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(512)
    expect(AI_VAULT_PARSE_CACHE_PERSIST_MAX_UTF8_BYTES).toBeLessThan(AI_VAULT_WHOLE_JSON_MAX_BYTES)
  })

  it('admits an exact-limit encoded app version and rejects one byte over', () => {
    const exact = 'x'.repeat(AI_VAULT_PARSE_CACHE_APP_VERSION_MAX_JSON_BYTES - 2)
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(
      AI_VAULT_PARSE_CACHE_APP_VERSION_MAX_JSON_BYTES
    )
    expect(() =>
      serializeSessionParseCachePayload({ schemaVersion: 1, appVersion: exact, entries: [] })
    ).not.toThrow()

    expect(() =>
      serializeSessionParseCachePayload({
        schemaVersion: 1,
        appVersion: `${exact}x`,
        entries: []
      })
    ).toThrow(`JSON output exceeds ${AI_VAULT_PARSE_CACHE_APP_VERSION_MAX_JSON_BYTES} bytes`)
  })
})
