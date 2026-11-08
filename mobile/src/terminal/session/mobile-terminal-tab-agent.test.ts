import { describe, expect, it } from 'vitest'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'

describe('resolveMobileTerminalTabAgentId', () => {
  it('keeps a completed Claude tab whose summary title names another agent', () => {
    expect(
      resolveMobileTerminalTabAgentId({
        title: 'Agy status bar item',
        launchAgent: 'claude',
        agentStatus: { state: 'done', agentType: 'claude' }
      })
    ).toBe('claude')
  })
})
