import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import {
  canShowMobileNativeChat,
  isMobileFolderNativeChatReadable,
  isMobileNativeChatTranscriptReadable,
  resolveMobileNativeChat,
  resolveMobileNativeChatFileSessionId
} from './mobile-native-chat-eligibility'

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey: 'tab:leaf',
    ...overrides
  } as AgentStatusEntry
}

describe('resolveMobileNativeChat', () => {
  it('addresses the conversation an idle Codex pane relays as a session boundary', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'codex',
        agentStatus: status({
          state: 'done',
          sessionBoundary: true,
          agentType: 'codex',
          providerSession: {
            key: 'session_id',
            id: 'codex-session',
            transcriptPath: '/tmp/codex-rollout.jsonl'
          }
        })
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'codex-session',
      transcriptPath: '/tmp/codex-rollout.jsonl'
    })
  })

  it('prefers the authoritative supported live agent over a stale launch hint', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: {
          agentType: 'codex',
          providerSession: { id: 'codex-session', transcriptPath: '/tmp/codex.jsonl' }
        }
      } as never)
    ).toMatchObject({ agent: 'codex', sessionId: 'codex-session' })
  })

  it('rejects an unsupported live agent instead of combining it with a stale hint', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: {
          agentType: 'gemini',
          providerSession: { id: 'gemini-session', transcriptPath: '/tmp/gemini.jsonl' }
        }
      } as never)
    ).toBeNull()
  })
  it('resolves agent + sessionId from launchAgent and provider session', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: status({
          providerSession: {
            key: 'session_id',
            id: 'sess-1',
            transcriptPath: '/tmp/claude-real-transcript.jsonl'
          }
        })
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'sess-1',
      transcriptPath: '/tmp/claude-real-transcript.jsonl'
    })
  })

  it('falls back to agentStatus.agentType when no launchAgent', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        agentStatus: status({ agentType: 'codex' })
      })
    ).toEqual({ agent: 'codex', sessionId: null, transcriptPath: null })
  })

  it('admits OpenClaude with its distinct agent identity', () => {
    expect(resolveMobileNativeChat({ type: 'terminal', launchAgent: 'openclaude' })).toEqual({
      agent: 'openclaude',
      sessionId: null,
      transcriptPath: null
    })
  })

  it.each(['opencode', 'opencode2'])('admits %s only on the execution host', (agent) => {
    const tab = {
      type: 'terminal',
      launchAgent: agent,
      agentStatus: status({
        providerSession: { key: 'session_id', id: 'real-session' }
      })
    }
    expect(resolveMobileNativeChat(tab, true)).toEqual({
      agent,
      sessionId: 'real-session',
      transcriptPath: null
    })
    expect(resolveMobileNativeChat(tab, false)).toBeNull()
  })

  it('returns null for unsupported agents', () => {
    expect(resolveMobileNativeChat({ type: 'terminal', launchAgent: 'gemini' })).toBeNull()
  })

  it('admits Grok only when its transcript is readable by the serving host', () => {
    const tab = { type: 'terminal', launchAgent: 'grok' }
    expect(resolveMobileNativeChat(tab, isMobileNativeChatTranscriptReadable(null))).toMatchObject({
      agent: 'grok'
    })
    expect(
      resolveMobileNativeChat(tab, isMobileNativeChatTranscriptReadable('runtime-ssh-environment'))
    ).toMatchObject({ agent: 'grok' })
    expect(
      resolveMobileNativeChat(tab, isMobileNativeChatTranscriptReadable('model-a-ssh'))
    ).toBeNull()
  })

  // Why: omp's hook reports no transcript path either, so mobile can only show
  // its chat when the serving host is the one holding the session file.
  it('admits omp only when its transcript is readable by the serving host', () => {
    const tab = { type: 'terminal', launchAgent: 'omp' }
    expect(resolveMobileNativeChat(tab, isMobileNativeChatTranscriptReadable(null))).toMatchObject({
      agent: 'omp'
    })
    expect(
      resolveMobileNativeChat(tab, isMobileNativeChatTranscriptReadable('runtime-ssh-environment'))
    ).toMatchObject({ agent: 'omp' })
    expect(
      resolveMobileNativeChat(tab, isMobileNativeChatTranscriptReadable('model-a-ssh'))
    ).toBeNull()
    expect(canShowMobileNativeChat(tab, isMobileNativeChatTranscriptReadable('model-a-ssh'))).toBe(
      false
    )
  })

  it('returns null for a plain shell (no agent)', () => {
    expect(resolveMobileNativeChat({ type: 'terminal' })).toBeNull()
  })

  it('returns null for non-terminal tabs', () => {
    expect(resolveMobileNativeChat({ type: 'browser', launchAgent: 'claude' })).toBeNull()
  })

  it('resolves Codex structured agent-session tabs directly', () => {
    expect(
      resolveMobileNativeChat({
        type: 'agent-session',
        sessionId: 'structured-1',
        agent: 'codex'
      })
    ).toEqual({
      agent: 'codex',
      sessionId: 'structured-1',
      transcriptPath: null
    })
  })

  it('resolves Claude structured agent-session tabs on the same journal path', () => {
    expect(
      resolveMobileNativeChat({
        type: 'agent-session',
        sessionId: 'structured-1',
        agent: 'claude'
      })
    ).toEqual({
      agent: 'claude',
      sessionId: 'structured-1',
      transcriptPath: null
    })
  })

  it('rejects structured agent-session tabs whose provider the reducer cannot replay', () => {
    expect(
      resolveMobileNativeChat({
        type: 'agent-session',
        sessionId: 'structured-1',
        agent: 'grok'
      })
    ).toBeNull()
  })

  it('canShowMobileNativeChat mirrors resolution', () => {
    expect(canShowMobileNativeChat({ type: 'terminal', launchAgent: 'claude' })).toBe(true)
    expect(canShowMobileNativeChat(null)).toBe(false)
  })
})

it('resolves folder readability from the serving host catalog and rejects Model-A SSH', () => {
  const read = (connectionId: unknown) =>
    isMobileFolderNativeChatReadable(
      {
        folderWorkspaces: [{ id: 'one', connectionId }]
      },
      'folder:one'
    )
  expect(read(null)).toBe(true)
  expect(read('ssh:box')).toBe(false)
  expect(isMobileFolderNativeChatReadable({ folderWorkspaces: [] }, 'folder:one')).toBe(false)
  expect(isMobileFolderNativeChatReadable(null, 'folder:one')).toBe(false)
})

describe('a terminal tab with the conversation field and no status', () => {
  const session = { key: 'session_id' as const, id: 'S', transcriptPath: '/r/S.jsonl' }
  const fieldTab = (agentType: string, offered: boolean) => ({
    type: 'terminal',
    conversationIdentity: { agentType, providerSession: session, capturedAt: 1, source: 'live' },
    ...(offered ? { conversationOfferedWithoutStatus: true as const } : {})
  })

  it.each(['codex', 'claude', 'omp'])(
    'opens an offered %s conversation from the field',
    (agent) => {
      expect(resolveMobileNativeChat(fieldTab(agent, true), true)).toEqual({
        agent,
        sessionId: 'S',
        transcriptPath: '/r/S.jsonl'
      })
      expect(resolveMobileNativeChatFileSessionId(fieldTab(agent, true))).toBe('S')
    }
  )

  it.each(['codex', 'claude', 'omp'])(
    'gives a %s field the host did not offer no chat',
    (agent) => {
      expect(resolveMobileNativeChat(fieldTab(agent, false), true)).toBeNull()
      expect(resolveMobileNativeChatFileSessionId(fieldTab(agent, false))).toBeNull()
    }
  )

  it('keeps a launched agent but no address when the field is not offered', () => {
    expect(
      resolveMobileNativeChat({ ...fieldTab('codex', false), launchAgent: 'codex' }, true)
    ).toEqual({ agent: 'codex', sessionId: null, transcriptPath: null })
  })

  it('never names the agent from the field beside a genuine status that lacks one', () => {
    expect(
      resolveMobileNativeChat(
        {
          ...fieldTab('codex', false),
          agentStatus: status({ state: 'done', providerSession: session })
        },
        true
      )
    ).toBeNull()
  })
})
