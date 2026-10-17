import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  applyMobileAiVaultScan,
  canPaintMobileAiVaultCache,
  clearMobileAiVaultMemoryCache,
  getMobileAiVaultCacheKey,
  MOBILE_AI_VAULT_INITIAL_LIMIT,
  MOBILE_AI_VAULT_SESSION_LIMIT,
  planMobileAiVaultLoad,
  readMobileAiVaultCache,
  writeMobileAiVaultCache,
  type MobileAiVaultCacheEntry
} from './mobile-ai-vault-session-cache'

const fingerprint = 'a'.repeat(64)

function session(id: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: 'main',
    model: null,
    filePath: `/repo/${id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-06-28T23:55:00.000Z',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

function entry(
  partial: Partial<MobileAiVaultCacheEntry> & Pick<MobileAiVaultCacheEntry, 'limit'>
): MobileAiVaultCacheEntry {
  return {
    sessions: partial.sessions ?? [session('s1')],
    issues: partial.issues ?? [],
    fingerprint: partial.fingerprint,
    limit: partial.limit
  }
}

beforeEach(() => {
  clearMobileAiVaultMemoryCache()
})

afterEach(() => {
  clearMobileAiVaultMemoryCache()
})

describe('mobile ai vault session cache', () => {
  it('keys by host, worktree id, and scope', () => {
    expect(getMobileAiVaultCacheKey('h1', 'wt1', 'workspace')).toBe('h1:wt1:workspace')
  })

  it('rejects a smaller-limit write over a fuller snapshot', () => {
    const key = getMobileAiVaultCacheKey('h', 'w', 'all')
    writeMobileAiVaultCache(key, entry({ limit: MOBILE_AI_VAULT_SESSION_LIMIT, fingerprint }))
    writeMobileAiVaultCache(key, entry({ limit: MOBILE_AI_VAULT_INITIAL_LIMIT, sessions: [session('late')] }))
    expect(readMobileAiVaultCache(key)?.sessions.map((row) => row.id)).toEqual(['s1'])
    expect(readMobileAiVaultCache(key)?.limit).toBe(MOBILE_AI_VAULT_SESSION_LIMIT)
  })

  it('allows painting all-scope cache immediately, but not scoped without paths', () => {
    expect(canPaintMobileAiVaultCache('all', [])).toBe(true)
    expect(canPaintMobileAiVaultCache('workspace', [])).toBe(false)
    expect(canPaintMobileAiVaultCache('workspace', ['/repo'])).toBe(true)
    expect(canPaintMobileAiVaultCache('project', ['/repo'])).toBe(true)
  })
})

describe('planMobileAiVaultLoad', () => {
  it('stages a cold load, fills a partial cache, and revalidates a full fingerprint', () => {
    expect(planMobileAiVaultLoad(null, false)).toEqual({
      kind: 'stage',
      firstLimit: MOBILE_AI_VAULT_INITIAL_LIMIT,
      thenLimit: MOBILE_AI_VAULT_SESSION_LIMIT
    })
    expect(planMobileAiVaultLoad(entry({ limit: MOBILE_AI_VAULT_INITIAL_LIMIT }), false)).toEqual({
      kind: 'fill',
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      afterFingerprint: null,
      force: false
    })
    expect(
      planMobileAiVaultLoad(
        entry({ limit: MOBILE_AI_VAULT_SESSION_LIMIT, fingerprint }),
        false
      )
    ).toEqual({
      kind: 'revalidate',
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      afterFingerprint: fingerprint
    })
  })

  it('opts into fingerprints with null when a full cache has none', () => {
    expect(
      planMobileAiVaultLoad(entry({ limit: MOBILE_AI_VAULT_SESSION_LIMIT }), false)
    ).toEqual({
      kind: 'fill',
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      afterFingerprint: null,
      force: false
    })
  })

  it('forces only a depth-250 fill so a shallow scan cannot overwrite the host cache', () => {
    expect(
      planMobileAiVaultLoad(
        entry({ limit: MOBILE_AI_VAULT_SESSION_LIMIT, fingerprint }),
        true
      )
    ).toEqual({
      kind: 'fill',
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      afterFingerprint: null,
      force: true
    })
  })
})

describe('applyMobileAiVaultScan', () => {
  it('keeps prior sessions on a matching unchanged reply instead of empty arrays', () => {
    const previous = entry({
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      fingerprint,
      sessions: [session('cached')]
    })
    expect(
      applyMobileAiVaultScan({
        previous,
        requestedLimit: MOBILE_AI_VAULT_SESSION_LIMIT,
        reply: { sessions: [], issues: [], fingerprint, unchanged: true }
      })
    ).toBe('keep')
  })

  it('asks for a full refetch when unchanged fingerprints disagree', () => {
    expect(
      applyMobileAiVaultScan({
        previous: entry({ limit: MOBILE_AI_VAULT_SESSION_LIMIT, fingerprint }),
        requestedLimit: MOBILE_AI_VAULT_SESSION_LIMIT,
        reply: {
          sessions: [],
          issues: [],
          fingerprint: 'b'.repeat(64),
          unchanged: true
        }
      })
    ).toBe('refetch-full')
  })

  it('treats a short initial page as a full-depth snapshot', () => {
    const applied = applyMobileAiVaultScan({
      previous: null,
      requestedLimit: MOBILE_AI_VAULT_INITIAL_LIMIT,
      reply: {
        sessions: [session('only')],
        issues: [],
        fingerprint
      }
    })
    expect(applied).toMatchObject({
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      fingerprint,
      sessions: [expect.objectContaining({ id: 'only' })]
    })
  })

  it('does not let a smaller request replace a deeper previous snapshot', () => {
    expect(
      applyMobileAiVaultScan({
        previous: entry({
          limit: MOBILE_AI_VAULT_SESSION_LIMIT,
          fingerprint,
          sessions: [session('deep')]
        }),
        requestedLimit: MOBILE_AI_VAULT_INITIAL_LIMIT,
        reply: { sessions: [session('shallow')], issues: [] }
      })
    ).toBe('keep')
  })
})
