import { describe, expect, it } from 'vitest'

import { acpProviderHandle, acpResumeSessionId } from './acp-session-identity'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'

function identity(
  providerHandle: AgentSessionJournalIdentity['providerHandle']
): AgentSessionJournalIdentity {
  return {
    sessionId: 'orca-session',
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: providerHandle.kind === 'opaque' ? providerHandle.agent : providerHandle.kind,
    providerHandle
  }
}

describe('acpResumeSessionId', () => {
  it('does not resume a pending opaque handle', () => {
    expect(
      acpResumeSessionId(identity({ kind: 'opaque', agent: 'grok', value: 'pending' }))
    ).toBeNull()
  })

  it('resumes grok and cursor from the opaque journal value', () => {
    expect(
      acpResumeSessionId(identity({ kind: 'opaque', agent: 'grok', value: 'grok-sess' }))
    ).toBe('grok-sess')
    expect(
      acpResumeSessionId(identity({ kind: 'opaque', agent: 'cursor', value: 'cursor-sess' }))
    ).toBe('cursor-sess')
  })

  it('resumes claude and codex from their journal kinds', () => {
    expect(
      acpResumeSessionId(identity({ kind: 'claude', sessionId: 'claude-sess', leafUuid: 'leaf-1' }))
    ).toBe('claude-sess')
    expect(acpResumeSessionId(identity({ kind: 'codex', threadId: 'thread-1' }))).toBe('thread-1')
  })
})

describe('acpProviderHandle', () => {
  it('mints durable provider handles, not journal kinds', () => {
    expect(acpProviderHandle('grok', 'grok-sess')).toEqual({
      provider: 'grok',
      sessionId: 'grok-sess'
    })
    expect(acpProviderHandle('cursor', 'cursor-sess')).toEqual({
      provider: 'cursor',
      sessionId: 'cursor-sess'
    })
    expect(acpProviderHandle('claude', 'claude-sess')).toEqual({
      provider: 'claude',
      sessionId: 'claude-sess',
      leafUuid: null
    })
  })
})
