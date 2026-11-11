import { describe, expect, it } from 'vitest'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'

describe('resolveMobileTerminalTabAgentId', () => {
  it('keeps a finished Claude tab whose session name mentions another agent', () => {
    expect(
      resolveMobileTerminalTabAgentId({
        title: 'Agy status bar item',
        aiVaultTitle: {
          agent: 'claude',
          sessionId: 'session-1',
          title: 'Agy status bar item',
          kind: 'named'
        },
        launchAgent: 'claude',
        agentStatus: { state: 'done', agentType: 'claude' }
      })
    ).toBe('claude')
  })
})
