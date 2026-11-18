import { describe, expect, it, vi } from 'vitest'
import { resolveMobileSourceControlLaunchAgent } from './mobile-source-control-launch-agent'

vi.mock('../../../i18n/mobile-i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Claude's chat runs on a program the host installs itself; no claude CLI is on its PATH.
const CHAT_HOST = {
  hostCapabilities: [
    'agent-session.structured.v1',
    'agent-session.structured.registered-agents.v1',
    'managed-runtime.install.v1',
    'agent.launch.surface.v1'
  ],
  registeredAgents: [
    {
      agent: 'claude',
      managedRuntime: true as const,
      capabilities: {
        rewind: false,
        compact: false,
        threadGoal: false,
        contextUsage: false,
        imagePrompts: false,
        steering: 'queue' as const,
        approvalEnforcement: 'orca' as const
      }
    }
  ]
}
const repo = {
  id: 'repo-1',
  sourceControlAi: { actionOverrides: { fixChecks: { agentId: 'claude' } } }
}

function contextWith(agentDefaultSurface: 'chat' | 'terminal') {
  return {
    settings: { nativeChatDefaults: { agentDefaultSurface, nativeChatProviders: {} } },
    detectedAgents: ['codex'],
    repo
  }
}

describe('resolveMobileSourceControlLaunchAgent', () => {
  it('launches a saved agent that opens as a chat without its CLI, as desktop does', () => {
    expect(
      resolveMobileSourceControlLaunchAgent(contextWith('chat'), 'fixChecks', CHAT_HOST)
    ).toMatchObject({
      kind: 'agent',
      agent: 'claude',
      chatOnly: true
    })
  })

  it('refuses that agent when its saved Terminal surface needs the missing CLI', () => {
    const terminalRepo = {
      id: 'repo-1',
      sourceControlAi: {
        actionOverrides: { fixChecks: { agentId: 'claude', surface: 'terminal' } }
      }
    }
    expect(
      resolveMobileSourceControlLaunchAgent(
        { ...contextWith('chat'), repo: terminalRepo },
        'fixChecks',
        CHAT_HOST
      )
    ).toMatchObject({ kind: 'unavailable' })
  })

  it('refuses that agent when the host would start it in a terminal', () => {
    expect(
      resolveMobileSourceControlLaunchAgent(contextWith('terminal'), 'fixChecks', CHAT_HOST)
    ).toMatchObject({ kind: 'unavailable' })
  })
})
