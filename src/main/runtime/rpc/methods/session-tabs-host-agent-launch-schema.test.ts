import { describe, expect, it } from 'vitest'
import { CreateTerminalTab } from './session-tabs-schemas'

const clientDefaultAgentSessionRules = {
  enabled: true,
  rules: [
    {
      id: 'client-rule',
      label: 'Client rule',
      content: 'Apply the client rule.',
      enabled: true,
      source: 'custom' as const
    }
  ],
  seenBuiltinRuleIds: ['builtin-graphify']
}

describe('session-tabs host agent launch schema', () => {
  it('preserves the optional execution-host launch intent', () => {
    const parsed = CreateTerminalTab.parse({
      worktree: 'id:wt-1',
      command: "codex 'client fallback'",
      launchAgent: 'codex',
      hostAgentLaunch: {
        kind: 'fresh',
        agent: 'codex',
        promptDelivery: 'draft',
        promptDeliveryOwner: 'client',
        agentArgs: '--model gpt-5',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        clientDefaultAgentSessionRules
      }
    })

    expect(parsed.hostAgentLaunch).toEqual({
      kind: 'fresh',
      agent: 'codex',
      promptDelivery: 'draft',
      promptDeliveryOwner: 'client',
      agentArgs: '--model gpt-5',
      launchPreferences: { model: 'gpt-5', effort: 'high' },
      clientDefaultAgentSessionRules
    })
  })

  it('rejects resume intents without a resumable provider identity', () => {
    expect(() =>
      CreateTerminalTab.parse({
        worktree: 'id:wt-1',
        command: "codex resume 'session-1'",
        launchAgent: 'codex',
        hostAgentLaunch: { kind: 'resume', agent: 'codex' }
      })
    ).toThrow('Host resume launch requires resumable identity')
  })

  it('rejects provider identities that a CLI could interpret as options', () => {
    expect(() =>
      CreateTerminalTab.parse({
        worktree: 'id:wt-1',
        command: 'codex resume --last',
        launchAgent: 'codex',
        hostAgentLaunch: {
          kind: 'resume',
          agent: 'codex',
          providerSession: { key: 'session_id', id: '--last' }
        }
      })
    ).toThrow('Invalid provider session ID')
  })

  it('measures host launch prompts as UTF-8 bytes', () => {
    expect(() =>
      CreateTerminalTab.parse({
        worktree: 'id:wt-1',
        command: 'opencode',
        launchAgent: 'opencode',
        hostAgentLaunch: {
          kind: 'fresh',
          agent: 'opencode',
          prompt: '界'.repeat(100_000)
        }
      })
    ).toThrow('Prompt is too large')
  })
})
