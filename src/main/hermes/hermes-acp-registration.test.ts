import { describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { decideAgentLaunchMode } from '../agent-launch/agent-launch-mode'
import { structuredAgentRuntimeRegistration } from '../runtime/agent-session/installation/structured-agent-runtime-registrations'

describe('Hermes ACP registration', () => {
  it('opens Hermes as a structured chat only when it is set to chat', () => {
    const placement = { agent: 'hermes', workspaceKind: 'git-worktree' } as const
    expect(
      decideAgentLaunchMode({ placement, settings: { nativeChatProviders: { hermes: true } } }).mode
    ).toBe('structured')
    for (const settings of [{}, { nativeChatProviders: { hermes: false } }]) {
      expect(decideAgentLaunchMode({ placement, settings })).toMatchObject({
        mode: 'terminal',
        reason: 'user_default'
      })
    }
  })

  it('registers Hermes on the ACP lane, pinning HERMES_HOME and approving full access itself', () => {
    const registration = structuredAgentRuntimeRegistration('hermes')
    expect(registration?.definition).toMatchObject({
      agent: 'hermes',
      handleTransport: 'acp',
      accountHomeVariable: 'HERMES_HOME',
      capabilities: {
        rewind: false,
        compact: true,
        imagePrompts: true,
        steering: 'queue',
        approvalEnforcement: 'orca'
      }
    })
    expect(registration?.launchCheck).toBeUndefined()
    const spec = acpLaunchSpecFor('hermes')
    expect(spec?.args({ fullAccess: false, pluginDir: '/plugin' })).toEqual(['acp'])
    // Hermes freezes --yolo into the session it creates, so a chat switched back to asking would
    // keep skipping approvals; Orca answers full-access requests itself instead.
    expect(spec?.args({ fullAccess: true, pluginDir: '/plugin' })).toEqual(['acp'])
    expect(spec?.historyCatchUp).toBeUndefined()
    expect(spec?.permissionModeConfig).toBeUndefined()
    expect(spec?.transcriptImport).toBeNull()
    expect(spec?.modelDiscovery).toEqual({
      kind: 'unavailable',
      reason: 'Hermes lists its models only in a chat session'
    })
    expect(spec?.authMethod?.({ advertised: ['hermes-setup', 'openrouter'], env: {} })).toBe(
      'openrouter'
    )
    expect(spec?.authMethod?.({ advertised: ['hermes-setup'], env: {} })).toBeUndefined()
  })
})
