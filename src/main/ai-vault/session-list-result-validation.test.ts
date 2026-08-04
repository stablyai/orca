import { describe, expect, it } from 'vitest'
import { parseAiVaultListResult } from './session-list-result-validation'

describe('parseAiVaultListResult', () => {
  it('keeps valid sessions when another wire entry is malformed', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession(), { id: 42 }],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]?.sessionId).toBe('session-1')
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({
        path: 'aiVault.listSessions',
        message: expect.stringContaining('Skipped 1 invalid')
      })
    )
  })

  it('preserves the optional session fields the panel renders', () => {
    const parsed = parseAiVaultListResult({
      sessions: [
        {
          ...validSession(),
          previewMessagesTruncated: true,
          firstUserPrompt: 'first',
          lastUserPrompt: 'last'
        }
      ],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions[0]).toMatchObject({
      previewMessagesTruncated: true,
      firstUserPrompt: 'first',
      lastUserPrompt: 'last'
    })
  })

  it('rejects a malformed result envelope', () => {
    expect(() => parseAiVaultListResult({ sessions: [] })).toThrow()
  })

  it('rejects a nonempty sessions array when every row is invalid', () => {
    expect(() =>
      parseAiVaultListResult({
        sessions: [{ id: 42 }, null],
        issues: [],
        scannedAt: '2026-07-27T00:00:00.000Z'
      })
    ).toThrow('all supplied Agent Session History sessions were invalid')
  })
})

function validSession(): Record<string, unknown> {
  return {
    id: 'local:codex:session-1:/tmp/session-1.jsonl',
    executionHostId: 'local',
    executionHostPlatform: 'linux',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Session one',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/tmp/session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-27T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume session-1',
    subagent: null
  }
}
