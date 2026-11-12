import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
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
})
