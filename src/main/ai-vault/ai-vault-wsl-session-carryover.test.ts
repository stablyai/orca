import { beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import {
  AI_VAULT_WSL_CARRYOVER_SCOPE_LIMIT,
  carryOverUnconfirmedWslSessions,
  resetAiVaultWslSessionCarryover
} from './ai-vault-wsl-session-carryover'

function wslSession(id: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd: null,
    branch: null,
    model: null,
    filePath: `\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\sessions\\${id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-29T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

function listOf(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: '2026-10-29T00:00:00.000Z' }
}

const confirm = (scope: string, ids: string[]) =>
  carryOverUnconfirmedWslSessions(scope, listOf(ids.map(wslSession)), true)
const probeFailed = (scope: string) =>
  carryOverUnconfirmedWslSessions(scope, listOf([]), false).sessions.map((session) => session.id)

describe('AI Vault WSL session carryover retention', () => {
  beforeEach(() => resetAiVaultWslSessionCarryover())

  it('keeps the active scope through a transient WSL probe failure', () => {
    confirm('scope-a', ['a1', 'a2'])

    expect(probeFailed('scope-a')).toEqual(['a1', 'a2'])
    // Same-scope recovery: a later confirmed scan replaces the carried rows.
    confirm('scope-a', ['a3'])
    expect(probeFailed('scope-a')).toEqual(['a3'])
  })

  it('evicts the least recently used scope past the cap', () => {
    const scopes = Array.from(
      { length: AI_VAULT_WSL_CARRYOVER_SCOPE_LIMIT + 1 },
      (_, index) => `scope-${index}`
    )
    for (const scope of scopes) {
      confirm(scope, [`${scope}-row`])
    }

    expect(probeFailed('scope-0')).toEqual([])
    for (const scope of scopes.slice(1)) {
      expect(probeFailed(scope)).toEqual([`${scope}-row`])
    }
  })

  it('keeps the scope the user is on when others are visited after it', () => {
    confirm('active', ['row'])
    for (let index = 0; index < AI_VAULT_WSL_CARRYOVER_SCOPE_LIMIT - 1; index += 1) {
      confirm(`other-${index}`, ['x'])
    }
    // Back on the active scope, its probe fails: carrying it over marks it recent.
    expect(probeFailed('active')).toEqual(['row'])
    confirm('one-more', ['x'])

    expect(probeFailed('active')).toEqual(['row'])
    expect(probeFailed('other-0')).toEqual([])
  })

  it('spends no slot on a scope with no WSL rows', () => {
    confirm('wsl-scope', ['w'])
    for (let index = 0; index < AI_VAULT_WSL_CARRYOVER_SCOPE_LIMIT * 2; index += 1) {
      confirm(`host-only-${index}`, [])
    }

    expect(probeFailed('wsl-scope')).toEqual(['w'])
  })

  it('an explicit delete still clears every scope', () => {
    confirm('scope-a', ['a1'])
    resetAiVaultWslSessionCarryover()

    expect(probeFailed('scope-a')).toEqual([])
  })
})
