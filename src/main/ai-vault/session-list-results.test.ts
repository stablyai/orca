import { describe, expect, it } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
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

describe('mergeAiVaultListResults', () => {
  it('does not cap an Unlimited all-host merge', () => {
    const sessions = Array.from({ length: 1001 }, (_, index) => session(index))
    const merged = mergeAiVaultListResults([{ ...listResult([]), sessions }], undefined, true)

    expect(merged.sessions).toHaveLength(1001)
  })

  it('keeps a per-host scope truncation notice when merging all-host results', () => {
    const merged = mergeAiVaultListResults(
      [listResult([]), listResult([SCOPE_TRUNCATION])],
      undefined
    )

    expect(merged.issues).toEqual([SCOPE_TRUNCATION])
  })

  it('keeps one scope notice per host rather than collapsing them', () => {
    const otherHost: AiVaultScanIssue = { ...SCOPE_TRUNCATION, executionHostId: 'ssh:build-box' }

    const merged = mergeAiVaultListResults(
      [listResult([SCOPE_TRUNCATION]), listResult([otherHost])],
      undefined
    )

    expect(merged.issues.map((issue) => issue.executionHostId)).toEqual([
      'ssh:dev-box',
      'ssh:build-box'
    ])
  })

  it('keeps a scope notice alongside a failing host so one bad host is not the whole story', () => {
    const hostDown: AiVaultScanIssue = {
      executionHostId: 'ssh:build-box',
      agent: 'codex',
      kind: 'host',
      path: 'build-box',
      message: 'Remote connection dropped.'
    }

    const merged = mergeAiVaultListResults(
      [listResult([SCOPE_TRUNCATION]), listResult([hostDown])],
      undefined
    )

    expect(merged.issues).toEqual([SCOPE_TRUNCATION, hostDown])
    // Kinded issues render as their own banner rows, never as skipped transcripts.
    expect(merged.issues.filter((issue) => !issue.kind)).toEqual([])
  })
})
