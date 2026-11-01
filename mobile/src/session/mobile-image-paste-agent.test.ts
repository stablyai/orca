import { describe, expect, it } from 'vitest'
import { resolveMobileImageAttachmentAgent } from './mobile-image-paste-agent'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { MobileSessionTab } from './mobile-session-route-types'

function status(agentType: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'tab-1:leaf-1',
    agentType,
    stateHistory: []
  }
}

function terminalTab(overrides: Partial<Extract<MobileSessionTab, { type: 'terminal' }>> = {}) {
  return {
    type: 'terminal',
    id: 'tab-1',
    title: 'Terminal',
    terminal: 'term-1',
    isActive: true,
    ...overrides
  } satisfies MobileSessionTab
}

describe('resolveMobileImageAttachmentAgent', () => {
  it('prefers the hook-reported agent', () => {
    const tab = terminalTab({
      agentStatus: status('codex'),
      launchAgent: 'claude'
    })
    expect(resolveMobileImageAttachmentAgent(tab, null)).toBe('codex')
  })

  it('uses the launched agent before the first hook status arrives', () => {
    expect(resolveMobileImageAttachmentAgent(terminalTab({ launchAgent: 'codex' }), null)).toBe(
      'codex'
    )
  })

  it('skips an unknown hook agent and falls back to the launched agent', () => {
    const tab = terminalTab({
      agentStatus: status('unknown'),
      launchAgent: 'codex'
    })
    expect(resolveMobileImageAttachmentAgent(tab, null)).toBe('codex')
  })

  it('ignores display-only titles when no agent identity is owned', () => {
    expect(resolveMobileImageAttachmentAgent(terminalTab({ title: 'OpenCode' }), null)).toBe(null)
  })

  it('falls back to the native chat agent when the terminal names none', () => {
    expect(resolveMobileImageAttachmentAgent(terminalTab(), 'claude')).toBe('claude')
    expect(resolveMobileImageAttachmentAgent(terminalTab(), null)).toBeNull()
  })

  it('uses the native chat agent for non-terminal tabs', () => {
    expect(resolveMobileImageAttachmentAgent(null, 'codex')).toBe('codex')
  })

  it('keeps terminal identity ahead of conflicting title and native chat identity', () => {
    expect(
      resolveMobileImageAttachmentAgent(
        terminalTab({ title: 'Codex ready', agentStatus: status(' omp '), launchAgent: 'claude' }),
        'gemini'
      )
    ).toBe('omp')
    expect(
      resolveMobileImageAttachmentAgent(
        terminalTab({ title: 'Codex ready', agentStatus: status('unknown'), launchAgent: 'omp' }),
        'claude'
      )
    ).toBe('omp')
  })
})
