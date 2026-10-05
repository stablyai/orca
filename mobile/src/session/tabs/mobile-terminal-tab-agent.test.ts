import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { MobileSessionTab } from './mobile-session-tabs'
import { terminalHandleRunsAgent } from './mobile-terminal-tab-agent'

function agentStatus(agentType: string | undefined): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'tab-1:leaf-1',
    ...(agentType ? { agentType } : {}),
    stateHistory: []
  }
}

function terminalTab(
  title: string,
  options: { agentType?: string; id: string; terminal: string; launchAgent?: TuiAgent }
): Extract<MobileSessionTab, { type: 'terminal' }> {
  return {
    type: 'terminal',
    id: options.id,
    title,
    terminal: options.terminal,
    isActive: true,
    ...(options.launchAgent ? { launchAgent: options.launchAgent } : {}),
    ...(options.agentType === undefined ? {} : { agentStatus: agentStatus(options.agentType) })
  }
}

describe('terminalHandleRunsAgent', () => {
  const tabs: MobileSessionTab[] = [
    terminalTab('zsh', { id: 'shell', terminal: 'term-shell' }),
    terminalTab('zsh', { id: 'agent', agentType: 'claude', terminal: 'term-agent' }),
    terminalTab('✳ Claude Code', { id: 'titled', terminal: 'term-titled' })
  ]

  it('joins only for a terminal whose agent Orca identified, not one named by its title', () => {
    expect(terminalHandleRunsAgent(tabs, 'term-agent')).toBe(true)
    expect(terminalHandleRunsAgent(tabs, 'term-shell')).toBe(false)
    expect(terminalHandleRunsAgent(tabs, 'term-titled')).toBe(false)
    expect(terminalHandleRunsAgent(tabs, 'term-missing')).toBe(false)
  })

  it('joins only for TUI agents and ignores a status row restored from disk', () => {
    const restored = terminalTab('zsh', {
      id: 'restored',
      agentType: 'claude',
      terminal: 'term-restored'
    })
    const others: MobileSessionTab[] = [
      terminalTab('zsh', { id: 'hook', agentType: 'dsb', terminal: 'term-hook' }),
      { ...restored, agentStatus: { ...restored.agentStatus!, restoredUnconfirmed: true } },
      terminalTab('zsh', { id: 'launched', launchAgent: 'codex', terminal: 'term-launched' })
    ]
    expect(terminalHandleRunsAgent(others, 'term-hook')).toBe(false)
    expect(terminalHandleRunsAgent(others, 'term-restored')).toBe(false)
    expect(terminalHandleRunsAgent(others, 'term-launched')).toBe(true)
  })
})
