import { describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
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
    expect(registration?.launchCheck).toMatchObject({
      minimumVersions: ['0.23.0'],
      versionArgs: ['acp']
    })
    const spec = acpLaunchSpecFor('hermes')
    expect(spec?.args({ fullAccess: false, pluginDirs: ['/plugin'] })).toEqual(['acp'])
    expect(spec?.args({ fullAccess: true, pluginDirs: ['/plugin'] })).toEqual(['acp'])
    expect(spec?.historyCatchUp).toBeUndefined()
    expect(spec?.permissionModeConfig?.fullAccessAnswersRequests).toBe(true)
    expect(spec?.modelDiscovery).toMatchObject({
      kind: 'session',
      listingNamesConfiguredModel: false,
      inPrivateFolder: true,
      listsOnDemand: true
    })
  })
})
