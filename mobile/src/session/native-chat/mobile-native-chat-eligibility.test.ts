import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../src/shared/agent-status-types'
import {
  canShowMobileNativeChat,
  isMobileFolderNativeChatReadable,
  resolveMobileNativeChat,
  resolveMobileNativeChatSessionId,
  withRememberedNativeChatIdentity
} from './mobile-native-chat-eligibility'
import type { MobileSessionTab } from '../mobile-session-route-types'
import { isNativeChatTranscriptLocalReadable } from '../../../../src/shared/native-chat/transcript/native-chat-transcript-readability'

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
      transcriptPath: '/tmp/claude-real-transcript.jsonl',
      agentConfirmed: true,
      sessionLive: true
    })
  })

  it('falls back to agentStatus.agentType when no launchAgent', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        agentStatus: status({ agentType: 'codex' })
      })
    ).toEqual({
      agent: 'codex',
      sessionId: null,
      transcriptPath: null,
      agentConfirmed: true,
      sessionLive: false
    })
  })

  it('admits OpenClaude with its distinct agent identity', () => {
    expect(resolveMobileNativeChat({ type: 'terminal', launchAgent: 'openclaude' })).toEqual({
      agent: 'openclaude',
      sessionId: null,
      transcriptPath: null,
      agentConfirmed: true,
      sessionLive: false
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
      transcriptPath: null,
      agentConfirmed: true,
      sessionLive: true
    })
    expect(resolveMobileNativeChat(tab, false)).toBeNull()
  })

  it('returns null for unsupported agents', () => {
    expect(resolveMobileNativeChat({ type: 'terminal', launchAgent: 'gemini' })).toBeNull()
  })

  it('admits Grok only when its transcript is readable by the serving host', () => {
    const tab = { type: 'terminal', launchAgent: 'grok' }
    expect(resolveMobileNativeChat(tab, isNativeChatTranscriptLocalReadable(null))).toMatchObject({
      agent: 'grok'
    })
    expect(
      resolveMobileNativeChat(tab, isNativeChatTranscriptLocalReadable('runtime-ssh-environment'))
    ).toMatchObject({ agent: 'grok' })
    expect(
      resolveMobileNativeChat(tab, isNativeChatTranscriptLocalReadable('model-a-ssh'))
    ).toBeNull()
  })

  it('admits omp only when its transcript is readable by the serving host', () => {
    const tab = { type: 'terminal', launchAgent: 'omp' }
    expect(resolveMobileNativeChat(tab, isNativeChatTranscriptLocalReadable(null))).toMatchObject({
      agent: 'omp'
    })
    expect(
      resolveMobileNativeChat(tab, isNativeChatTranscriptLocalReadable('runtime-ssh-environment'))
    ).toMatchObject({ agent: 'omp' })
    expect(
      resolveMobileNativeChat(tab, isNativeChatTranscriptLocalReadable('model-a-ssh'))
    ).toBeNull()
    expect(canShowMobileNativeChat(tab, isNativeChatTranscriptLocalReadable('model-a-ssh'))).toBe(
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
      transcriptPath: null,
      agentConfirmed: true,
      sessionLive: true
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
      transcriptPath: null,
      agentConfirmed: true,
      sessionLive: true
    })
  })

  it.each(['grok', 'opencode', 'omp', 'pi'])(
    'resolves %s structured agent-session tabs on the same journal path',
    (agent) => {
      expect(
        resolveMobileNativeChat({ type: 'agent-session', sessionId: 'structured-1', agent })
      ).toEqual({
        agent,
        sessionId: 'structured-1',
        transcriptPath: null,
        agentConfirmed: true,
        sessionLive: true
      })
    }
  )

  it('rejects structured agent-session tabs with no session or an unreadable agent id', () => {
    expect(resolveMobileNativeChat({ type: 'agent-session', agent: 'grok' })).toBeNull()
    expect(
      resolveMobileNativeChat({
        type: 'agent-session',
        sessionId: 'structured-1',
        agent: 'Not An Id'
      })
    ).toBeNull()
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

describe('withRememberedNativeChatIdentity', () => {
  const terminalTab = (
    terminal: string | null,
    agentStatus?: AgentStatusEntry,
    launchAgent?: 'claude'
  ): MobileSessionTab => ({
    type: 'terminal',
    id: 'tab-1',
    title: 'claude',
    terminal,
    isActive: true,
    ...(agentStatus ? { agentStatus } : {}),
    ...(launchAgent ? { launchAgent } : {})
  })
  const claude = status({
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1', transcriptPath: '/t/sess-1.jsonl' }
  })
  const seen = withRememberedNativeChatIdentity([terminalTab('h1', claude)], [])

  // Remembered agent identity keeps chat readable, never writable: it may have exited to a shell.
  it('keeps chat read-only on the same handle when a frame omits the agent', () => {
    const [next] = withRememberedNativeChatIdentity([terminalTab('h1', status())], seen)
    expect(resolveMobileNativeChat(next)).toEqual({
      agent: 'claude',
      sessionId: 'sess-1',
      transcriptPath: '/t/sess-1.jsonl',
      agentConfirmed: false,
      sessionLive: false
    })
    expect(resolveMobileNativeChatSessionId(next)).toBe('sess-1')
  })

  it('keeps the session through a frame with no agent status, and a pending handle', () => {
    const [pending] = withRememberedNativeChatIdentity([terminalTab(null)], seen)
    const [back] = withRememberedNativeChatIdentity([terminalTab('h1')], [pending])
    expect(resolveMobileNativeChat(back)?.sessionId).toBe('sess-1')
  })

  it('forgets the identity on a new handle or a different live agent', () => {
    const [restarted] = withRememberedNativeChatIdentity([terminalTab('h2')], seen)
    expect(resolveMobileNativeChat(restarted)).toBeNull()
    const [codex] = withRememberedNativeChatIdentity(
      [terminalTab('h1', status({ agentType: 'codex' }))],
      seen
    )
    expect(resolveMobileNativeChat(codex)).toEqual({
      agent: 'codex',
      sessionId: null,
      transcriptPath: null,
      agentConfirmed: true,
      sessionLive: false
    })
  })

  it('does not show the previous conversation when the agent relaunches in the pane', () => {
    const [relaunched] = withRememberedNativeChatIdentity(
      [terminalTab('h1', status({ agentType: 'claude' }))],
      seen
    )
    expect(resolveMobileNativeChat(relaunched)?.sessionId).toBeNull()
    const [later] = withRememberedNativeChatIdentity([terminalTab('h1', status())], [relaunched])
    expect(resolveMobileNativeChat(later)?.sessionId).toBeNull()
  })

  it('lets the launch hint outrank the remembered agent, as desktop does', () => {
    const launched = (agentStatus?: AgentStatusEntry) => terminalTab('h1', agentStatus, 'claude')
    const switched = withRememberedNativeChatIdentity(
      [launched(status({ agentType: 'codex' }))],
      []
    )
    const [next] = withRememberedNativeChatIdentity([launched()], switched)
    expect(resolveMobileNativeChat(next)).toMatchObject({
      agent: 'claude',
      agentConfirmed: true
    })
  })
})
