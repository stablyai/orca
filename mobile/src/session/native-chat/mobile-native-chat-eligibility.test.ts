import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import {
  resolveMobileNativeChat,
  withRememberedNativeChatIdentity
} from './mobile-native-chat-eligibility'
import type { MobileSessionTab } from '../mobile-session-route-types'

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

  it('does not show the previous conversation when the agent relaunches in the pane', () => {
    const [relaunched] = withRememberedNativeChatIdentity(
      [terminalTab('h1', status({ agentType: 'claude' }))],
      seen
    )
    expect(resolveMobileNativeChat(relaunched)?.sessionId).toBeNull()
    const [later] = withRememberedNativeChatIdentity([terminalTab('h1', status())], [relaunched])
    expect(resolveMobileNativeChat(later)?.sessionId).toBeNull()
  })
})
