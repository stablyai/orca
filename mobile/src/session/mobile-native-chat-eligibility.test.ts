import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { canShowMobileNativeChat, resolveMobileNativeChat } from './mobile-native-chat-eligibility'

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
  it('resolves agent + sessionId from launchAgent and provider session', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: status({ providerSession: { id: 'sess-1' } as never })
      })
    ).toEqual({ agent: 'claude', sessionId: 'sess-1', transcriptPath: null })
  })

  it('surfaces the hook transcriptPath when the provider session carries one', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: status({
          providerSession: { id: 'sess-1', transcriptPath: '/x/real.jsonl' } as never
        })
      })
    ).toEqual({ agent: 'claude', sessionId: 'sess-1', transcriptPath: '/x/real.jsonl' })
  })

  it('falls back to agentStatus.agentType when no launchAgent', () => {
    expect(
      resolveMobileNativeChat({
        type: 'terminal',
        agentStatus: status({ agentType: 'codex' })
      })
    ).toEqual({ agent: 'codex', sessionId: null, transcriptPath: null })
  })

  it('returns null for unsupported agents', () => {
    expect(resolveMobileNativeChat({ type: 'terminal', launchAgent: 'gemini' })).toBeNull()
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
