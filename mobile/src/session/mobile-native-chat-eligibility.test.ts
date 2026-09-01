import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import {
  canShowMobileNativeChat,
  isMobileNativeChatTranscriptReadable,
  resolveMobileNativeChat
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

  it('resolves a custom agent id to its base harness (desktop parity)', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'custom-agent:claude:5f9f1c3a-1111-4222-8333-444455556666'
      })
    ).toEqual({ agent: 'claude', sessionId: null, transcriptPath: null })
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        agentStatus: status({
          agentType: 'custom-agent:codex:5f9f1c3a-1111-4222-8333-444455556666'
        })
      })
    ).toEqual({ agent: 'codex', sessionId: null, transcriptPath: null })
  })

  it('still rejects a custom agent on an unsupported base', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'custom-agent:gemini:5f9f1c3a-1111-4222-8333-444455556666'
      })
    ).toBeNull()
  })

  it('returns null for a plain shell (no agent)', () => {
    expect(resolveMobileNativeChat({ type: 'terminal' })).toBeNull()
  })

  it('returns null for non-terminal tabs', () => {
    expect(resolveMobileNativeChat({ type: 'browser', launchAgent: 'claude' })).toBeNull()
  })

  it('canShowMobileNativeChat mirrors resolution', () => {
    expect(canShowMobileNativeChat({ type: 'terminal', launchAgent: 'claude' })).toBe(true)
    expect(canShowMobileNativeChat(null)).toBe(false)
  })
})
