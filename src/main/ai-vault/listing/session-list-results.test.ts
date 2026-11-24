import { expect, it } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { mergeAiVaultListResults } from './session-list-results'

function listResult(issues: AiVaultScanIssue[]): AiVaultListResult {
  return { sessions: [], issues, scannedAt: '2026-08-02T00:00:00.000Z' }
}

function session(index: number): AiVaultSession {
  const id = `session-${index}`
  const timestamp = new Date(Date.UTC(2026, 7, 2, 0, 0, index)).toISOString()
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    modifiedAt: timestamp,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: id,
    subagent: null
  }
}

it('retains a selected remote conversation beyond the merged result limit', () => {
  const selected = {
    ...session(0),
    executionHostId: 'runtime:server' as const,
    id: 'remote-selected'
  }
  const results = [
    { ...listResult([]), sessions: [session(2)] },
    { ...listResult([]), sessions: [session(1), selected] }
  ]
  expect(
    mergeAiVaultListResults(results, 1, false, [], 'remote-selected').sessions.map((row) => row.id)
  ).toEqual(['session-2', 'remote-selected'])
  expect(mergeAiVaultListResults(results, 1).sessions.map((row) => row.id)).toEqual(['session-2'])
})
