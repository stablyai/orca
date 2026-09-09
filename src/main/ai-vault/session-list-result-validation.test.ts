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

  it('keeps known-agent sessions while silently dropping unknown-agent rows', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession(), { ...validSession('session-new'), agent: 'future-agent' }],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]?.agent).toBe('codex')
    expect(parsed.sessions[0]?.sessionId).toBe('session-1')
    expect(parsed.issues).toEqual([])
  })

  it('accepts an all-unknown-agent response as an empty supported session list', () => {
    const parsed = parseAiVaultListResult({
      sessions: [
        { ...validSession('future-1'), agent: 'future-agent' },
        { ...validSession('future-2'), agent: 'newer-agent' }
      ],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions).toEqual([])
    expect(parsed.issues).toEqual([])
  })

  it('keeps known scan issues while silently dropping unknown-agent issues', () => {
    const parsed = parseAiVaultListResult({
      sessions: [],
      issues: [validScanIssue(), validScanIssue('future-agent')],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues).toEqual([validScanIssue()])
  })

  it('reports malformed scan issues without counting unknown-agent issues as invalid', () => {
    const parsed = parseAiVaultListResult({
      sessions: [],
      issues: [validScanIssue(), { agent: 'future-agent' }, validScanIssue('newer-agent')],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues).toEqual([
      validScanIssue(),
      expect.objectContaining({
        path: 'aiVault.listSessions',
        message: expect.stringContaining('Skipped 1 invalid')
      })
    ])
  })

  it('does not throw when malformed rows are mixed with well-formed unknown sessions', () => {
    const parsed = parseAiVaultListResult({
      sessions: [
        { ...validSession('malformed-future'), agent: 'future-agent', messageCount: 'invalid' },
        { ...validSession('valid-future'), agent: 'newer-agent' }
      ],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions).toEqual([])
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

  // #15036: a `kind` this build has never heard of used to fail the whole issue,
  // and the fallback re-reported it as an unkinded entry — i.e. a newer host's
  // whole-source failure came back to an older client as a skipped transcript.
  it('keeps an issue whose kind this build does not know, as its own kinded row', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [
        {
          agent: 'opencode',
          kind: 'source-from-a-newer-host',
          path: '/home/ada/.local/share/opencode/opencode.db',
          message: 'OpenCode history was skipped.'
        }
      ],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues).toEqual([
      expect.objectContaining({ kind: 'scope', message: 'OpenCode history was skipped.' })
    ])
    expect(parsed.issues.some((issue) => issue.message.includes('invalid'))).toBe(false)
  })

  it('leaves an unkinded issue unkinded so real skipped transcripts still count', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [{ agent: 'codex', path: '/bad.jsonl', message: 'Malformed transcript' }],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues[0]?.kind).toBeUndefined()
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

function validSession(sessionId = 'session-1'): Record<string, unknown> {
  return {
    id: `local:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    executionHostPlatform: 'linux',
    agent: 'codex',
    sessionId,
    title: 'Session one',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-27T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

function validScanIssue(agent = 'codex'): Record<string, unknown> {
  return {
    agent,
    path: '/tmp/sessions',
    message: 'permission denied'
  }
}
