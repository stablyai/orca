import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { AgentProcessPresence } from '../../../src/shared/agent-process-presence'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { resolveMobileNativeChat, type MobileNativeChatTab } from './mobile-native-chat-eligibility'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'

// The host publishes its owner beside the turn (`tab.agentPresence`), never inside `agentStatus`.
type PresenceTab = MobileNativeChatTab & { title: string; launchAgent?: TuiAgent | null }

function tab(ended?: true): PresenceTab {
  const agentStatus: AgentStatusEntry = {
    state: 'done',
    prompt: '',
    paneKey: 'tab:leaf',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session' }
  }
  const agentPresence: AgentProcessPresence = {
    agent: 'claude',
    process: { pid: 42, platform: 'linux', startTime: 'boot:42' },
    ...(ended ? { ended } : {})
  }
  return {
    type: 'terminal',
    title: 'claude',
    launchAgent: 'claude',
    agentStatus,
    agentPresence
  }
}
describe('host process presence on mobile', () => {
  it('retains an idle owner under a shell title', () => {
    const live = { ...tab(), title: 'zsh' }
    expect(resolveMobileTerminalTabAgentId(live)).toBe('claude')
    expect(resolveMobileNativeChat(live)?.sessionId).toBe('session')
  })
  it('does not revive an ended owner from title, launch or transcript identity', () => {
    expect(resolveMobileTerminalTabAgentId(tab(true))).toBeNull()
    expect(resolveMobileNativeChat(tab(true))).toBeNull()
  })
  it('shows a hookless agent started after the owner exited, as it would without presence', () => {
    const successor = { ...tab(true), title: 'aider' }
    expect(resolveMobileTerminalTabAgentId(successor)).toBe('aider')
    const withoutPresence = {
      ...successor,
      agentStatus: undefined,
      agentPresence: undefined,
      launchAgent: undefined
    }
    expect(resolveMobileTerminalTabAgentId(withoutPresence)).toBe('aider')
  })
  it('keeps old-host and unidentified rows on the legacy path', () => {
    const legacy = tab()
    legacy.agentPresence = undefined
    expect(resolveMobileNativeChat(legacy)?.agent).toBe('claude')
    legacy.agentPresence = { agent: 'claude', ended: true }
    expect(resolveMobileTerminalTabAgentId(legacy)).toBe('claude')
  })
})
