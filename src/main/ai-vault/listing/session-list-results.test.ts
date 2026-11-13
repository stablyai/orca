import { expect, it } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { truncateAiVaultListResult } from '../../../shared/ai-vault/scanning/ai-vault-session-depth'
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

const SCOPE_TRUNCATION: AiVaultScanIssue = {
  executionHostId: 'ssh:dev-box',
  agent: 'codex',
  kind: 'scope',
  path: '/home/ada',
  message: 'Only the first 64 project paths were scanned.'
}

it('retains recovered scope rows through All-computers aggregation and smaller cached depths', () => {
  const local = {
    ...listResult([SCOPE_TRUNCATION]),
    sessions: [{ ...session(4), cwd: '/other' }, { ...session(3), cwd: '/other' }, session(1)]
  }
  const merged = mergeAiVaultListResults([local, listResult([])], 2, false, ['/repo'])
  expect(merged.sessions.map((row) => row.sessionId)).toEqual([
    'session-4',
    'session-3',
    'session-1'
  ])
  expect(
    truncateAiVaultListResult(merged, 1, ['/repo']).sessions.map((row) => row.sessionId)
  ).toEqual(['session-4', 'session-1'])
  expect(merged.issues).toEqual([SCOPE_TRUNCATION])
  expect(merged.scannedAt).toBe(local.scannedAt)
})
