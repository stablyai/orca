import { describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { mergeAiVaultListResults } from './session-list-results'

function session(id: string, modifiedAt: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: 'main',
    model: null,
    filePath: `/${id}`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `claude --resume ${id}`,
    subagent: null
  }
}

function result(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: '2026-01-01T00:00:00.000Z' }
}

describe('AI Vault list result merging', () => {
  it('applies the result limit after later hosts replace duplicate sessions', () => {
    const newest = session('duplicate', '2026-04-03T00:00:00.000Z')
    const fallback = session('fallback', '2026-04-02T00:00:00.000Z')
    const replacement = session('duplicate', '2026-04-01T00:00:00.000Z')
    const otherHost = session('other-host', '2026-04-01T12:00:00.000Z')

    const merged = mergeAiVaultListResults(
      [result([newest, fallback]), result([replacement, otherHost])],
      1
    )

    expect(merged.sessions).toEqual([fallback])
  })
})
