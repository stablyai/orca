import { describe, expect, it } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import {
  AI_VAULT_SCAN_ISSUE_MAX_ENTRIES,
  AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES,
  AI_VAULT_SESSION_ID_MAX_UTF8_BYTES,
  AI_VAULT_SESSION_LIST_CACHE_KEY_MAX_JSON_BYTES,
  AI_VAULT_SESSION_PATH_MAX_UTF8_BYTES,
  AiVaultSessionCapacityError,
  aiVaultSessionListCacheKey,
  boundAiVaultListResult,
  retainAiVaultSession,
  retainAiVaultSessionsWithinAggregate
} from './session-list-retention'

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:session:/transcript',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session',
    title: 'Title',
    cwd: '/repo',
    branch: 'main',
    model: 'claude-test',
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
    subagent: null,
    ...overrides
  }
}

function result(sessions: AiVaultSession[], issues: AiVaultScanIssue[] = []): AiVaultListResult {
  return { sessions, issues, scannedAt: '2026-01-01T00:00:00.000Z' }
}

describe('AI Vault session list retention', () => {
  it('returns exact under-limit sessions and results by identity', () => {
    const normalSession = session()
    const normalResult = result(
      [normalSession],
      [{ agent: 'claude', path: '/transcript', message: 'recoverable warning' }]
    )

    expect(retainAiVaultSession(normalSession)).toBe(normalSession)
    expect(boundAiVaultListResult(normalResult)).toBe(normalResult)
  })

  it('accepts exact UTF-8 identity/path limits and rejects one byte over', () => {
    const exactId = 'é'.repeat(AI_VAULT_SESSION_ID_MAX_UTF8_BYTES / 2)
    const exactPath = 'é'.repeat(AI_VAULT_SESSION_PATH_MAX_UTF8_BYTES / 2)
    expect(retainAiVaultSession(session({ sessionId: exactId, filePath: exactPath }))).toEqual(
      expect.objectContaining({ sessionId: exactId, filePath: exactPath })
    )

    expect(() => retainAiVaultSession(session({ sessionId: `${exactId}x` }))).toThrow(
      AiVaultSessionCapacityError
    )
    expect(() => retainAiVaultSession(session({ filePath: `${exactPath}x` }))).toThrow(
      AiVaultSessionCapacityError
    )
  })

  it('UTF-8 truncates display-only metadata without splitting a code point', () => {
    const exact = 'é'.repeat(AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES / 2)
    expect(retainAiVaultSession(session({ model: exact })).model).toBe(exact)

    const retained = retainAiVaultSession(session({ model: `${exact}x` }))
    expect(retained.model).toMatch(/\.\.\.$/)
    expect(Buffer.byteLength(retained.model ?? '', 'utf8')).toBeLessThanOrEqual(
      AI_VAULT_SESSION_DISPLAY_FIELD_MAX_UTF8_BYTES
    )
    expect(retained.model).not.toContain('\ufffd')
  })

  it('uses the exact list boundary and keeps the newest session prefix', () => {
    const sessions = [session({ id: 'newest' }), session({ id: 'older' })]
    const exactArrayBytes = Buffer.byteLength(JSON.stringify(sessions), 'utf8')
    expect(retainAiVaultSessionsWithinAggregate(sessions, exactArrayBytes)).toEqual({
      sessions,
      omitted: 0
    })
    expect(retainAiVaultSessionsWithinAggregate(sessions, exactArrayBytes - 1)).toEqual({
      sessions: [sessions[0]],
      omitted: 1
    })

    const exactResult = result(sessions)
    const exactResultBytes = Buffer.byteLength(JSON.stringify(exactResult), 'utf8')
    expect(boundAiVaultListResult(exactResult, exactResultBytes)).toBe(exactResult)
    const overflow = boundAiVaultListResult(exactResult, exactResultBytes - 1)
    expect(Buffer.byteLength(JSON.stringify(overflow), 'utf8')).toBeLessThanOrEqual(
      exactResultBytes - 1
    )
    expect(overflow.issues.at(-1)?.message).toContain('AI Vault omitted')
  })

  it('turns critical overflow into one bounded issue and caps issue count', () => {
    const oversized = session({
      sessionId: 'x'.repeat(AI_VAULT_SESSION_ID_MAX_UTF8_BYTES + 1)
    })
    const issues = Array.from({ length: AI_VAULT_SCAN_ISSUE_MAX_ENTRIES + 1 }, (_, index) => ({
      agent: 'claude' as const,
      path: `/warning/${index}`,
      message: 'warning'
    }))

    const bounded = boundAiVaultListResult(result([oversized], issues))
    expect(bounded.sessions).toEqual([])
    expect(bounded.issues).toHaveLength(AI_VAULT_SCAN_ISSUE_MAX_ENTRIES)
    expect(bounded.issues.at(-1)?.message).toContain('1 sessions and 2 scan issues')
  })

  it('admits an exact-limit cache key and bypasses caching one byte over', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ scopePaths: [''] }), 'utf8')
    const exact = {
      scopePaths: ['x'.repeat(AI_VAULT_SESSION_LIST_CACHE_KEY_MAX_JSON_BYTES - overhead)]
    }
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(
      AI_VAULT_SESSION_LIST_CACHE_KEY_MAX_JSON_BYTES
    )
    expect(aiVaultSessionListCacheKey(exact)).toBe(JSON.stringify(exact))
    expect(aiVaultSessionListCacheKey({ scopePaths: [`${exact.scopePaths[0]}x`] })).toBeNull()
  })
})
