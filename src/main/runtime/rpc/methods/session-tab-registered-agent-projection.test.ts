import { describe, expect, it } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-types'
import {
  STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE,
  assertAgentSessionTabDestructiveMutationSupported,
  projectSessionTabAgentStatus
} from './session-tab-agent-status-projection'

const TODAYS_CLIENT = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
]
const REGISTERED_AGENTS_CLIENT = [
  ...TODAYS_CLIENT,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]

function chatTab(agent: string, isActive: boolean) {
  return {
    type: 'agent-session' as const,
    id: `agent-session:${agent}-session`,
    title: `${agent} chat`,
    sessionId: `${agent}-session`,
    agent,
    isActive
  }
}

function snapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-a',
    activeTabId: 'agent-session:grok-session',
    activeTabType: 'agent-session',
    tabGroups: [
      {
        id: 'group-a',
        activeTabId: 'agent-session:grok-session',
        tabOrder: [
          'agent-session:claude-session',
          'agent-session:codex-session',
          'agent-session:grok-session'
        ]
      }
    ],
    tabs: [chatTab('claude', false), chatTab('codex', false), chatTab('grok', true)]
  }
}

describe('a tab of an agent beyond Claude and Codex', () => {
  it("is withheld from a paired client that does not render the host's agents", () => {
    const projected = projectSessionTabAgentStatus(snapshot(), 'runtime', TODAYS_CLIENT)
    expect(projected.tabs.map((tab) => tab.id)).toEqual([
      'agent-session:claude-session',
      'agent-session:codex-session'
    ])
    expect(projected.tabGroups?.[0]?.tabOrder).not.toContain('agent-session:grok-session')
    expect(projected.activeTabId).not.toBe('agent-session:grok-session')
  })

  it('reaches a client that advertises the registered-agents capability unchanged', () => {
    const payload = snapshot()
    expect(projectSessionTabAgentStatus(payload, 'runtime', REGISTERED_AGENTS_CLIENT)).toBe(payload)
  })

  it('holds a Pi tab for clients that understand registered agents but cannot show Pi dialogs', () => {
    const payload = {
      ...snapshot(),
      tabs: [...snapshot().tabs, chatTab('pi', false)]
    }
    const old = projectSessionTabAgentStatus(payload, 'runtime', REGISTERED_AGENTS_CLIENT)
    expect(old.tabs.map((tab) => tab.id)).not.toContain('agent-session:pi-session')
    expect(
      projectSessionTabAgentStatus(payload, 'runtime', [
        ...REGISTERED_AGENTS_CLIENT,
        PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY
      ])
    ).toBe(payload)
    expect(
      projectSessionTabAgentStatus(payload, 'mobile', REGISTERED_AGENTS_CLIENT).tabs.at(-1)
    ).toMatchObject({ title: STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE })
  })

  it('stays listed on a phone under the title that names the fix', () => {
    const projected = projectSessionTabAgentStatus(snapshot(), 'mobile', TODAYS_CLIENT)
    expect(projected.tabs.map((tab) => tab.title)).toEqual([
      'claude chat',
      'codex chat',
      STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE
    ])
  })

  it('cannot be closed by a client that cannot render it', () => {
    expect(() =>
      assertAgentSessionTabDestructiveMutationSupported(
        snapshot(),
        'agent-session:grok-session',
        'runtime',
        TODAYS_CLIENT
      )
    ).toThrow('structured_agent_session_unsupported')
    expect(() =>
      assertAgentSessionTabDestructiveMutationSupported(
        snapshot(),
        'agent-session:grok-session',
        'runtime',
        REGISTERED_AGENTS_CLIENT
      )
    ).not.toThrow()
  })

  it('leaves Claude and Codex tabs as they were for every client', () => {
    const payload = { ...snapshot(), tabs: snapshot().tabs.slice(0, 2) }
    expect(projectSessionTabAgentStatus(payload, 'runtime', TODAYS_CLIENT)).toBe(payload)
    expect(
      projectSessionTabAgentStatus(payload, 'runtime', [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ]).tabs.map((tab) => tab.id)
    ).toEqual(['agent-session:codex-session'])
  })
})
