import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'

describe('mobile web agent-history authority', () => {
  it('keeps native session data behind stable opaque handles and revokes stale rows', () => {
    const authority = new MobileWebAgentHistoryAuthority((length) => new Uint8Array(length).fill(7))
    const first = session('native-session-1', '/private/transcripts/one.jsonl')
    const second = session('native-session-2', '/private/transcripts/two.jsonl')

    authority.synchronize([first, second])
    const firstHandle = authority.pageHandle(first.id)
    const secondHandle = authority.pageHandle(second.id)

    expect(firstHandle).toMatch(/^agent_session_0_[a-f0-9]{32}$/)
    expect(firstHandle).not.toContain(first.id)
    expect(firstHandle).not.toContain(first.filePath)
    expect(authority.hostSession(firstHandle)).toEqual(first)
    expect(() => authority.assertSession(firstHandle, first)).not.toThrow()

    const refreshed = { ...first, title: 'Refreshed title' }
    authority.synchronize([refreshed])

    expect(authority.pageHandle(first.id)).toBe(firstHandle)
    expect(authority.hostSession(firstHandle)).toEqual(refreshed)
    expect(() => authority.assertSession(firstHandle, first)).toThrow('conflict')
    expect(() => authority.hostSession(secondHandle)).toThrow()
  })

  it('revokes every handle on bridge-session teardown', () => {
    const authority = new MobileWebAgentHistoryAuthority((length) => new Uint8Array(length))
    const value = session('native-session-1', '/private/transcripts/one.jsonl')
    authority.synchronize([value])
    const handle = authority.pageHandle(value.id)

    authority.clear()

    expect(() => authority.hostSession(handle)).toThrow()
    expect(() => authority.assertSession(handle, value)).toThrow('not_found')
  })

  it('rejects an invalid random-byte source', () => {
    const authority = new MobileWebAgentHistoryAuthority(() => new Uint8Array(15))
    expect(() =>
      authority.synchronize([session('native-session-1', '/private/one.jsonl')])
    ).toThrow()
  })
})

function session(id: string, filePath: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: `provider-${id}`,
    title: 'Session title',
    cwd: '/private/workspace',
    branch: 'mobile-rearch',
    model: null,
    filePath,
    codexHome: '/private/codex-home',
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-26T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'private resume command',
    subagent: null
  }
}
