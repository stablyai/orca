import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { structuredAgentConfiguredArgs } from '../native-chat/structured-agent-configured-args'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { agentLaunchSettingsMutationUpdates } from '../../shared/agent-launch-settings'
import { AgentLaunchSettingsMutation } from '../../shared/rpc-contract/agent-launch-settings-params'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc/runtime-rpc-mobile-method-allowlist'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn(async () => {})
}))

function fixture() {
  const host = createGlobalSettingsFixture({
    workspaceDir: '/host',
    agentDefaultArgs: { claude: '--host-old', codex: '--host-codex' },
    agentDefaultEnv: { claude: { API_KEY: 'host-secret', KEEP: 'host-only' } },
    agentCmdOverrides: { codex: '/host/codex' }
  })
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => Object.assign(host, updates))
  const runDurableMutation: NonNullable<RuntimeStore['runDurableMutation']> = async (mutate) =>
    mutate().value
  const controller = new RuntimeClientSettingsController({
    getSettings: () => host,
    updateSettings,
    runDurableMutation
  })
  return { host, updateSettings, controller }
}

describe('execution-host agent launch settings', () => {
  it('edits the store the structured host reads, leaving desktop choices on the desktop', async () => {
    const desktop = createGlobalSettingsFixture({
      workspaceDir: '/desktop',
      agentDefaultArgs: { claude: '--desktop-marker' },
      agentDefaultEnv: { claude: { API_KEY: 'desktop-secret' } }
    })
    const { controller, host } = fixture()
    await controller.mutateAgentLaunch({
      type: 'command',
      agent: 'claude',
      value: '/host/claude-wrapper'
    })
    await controller.mutateAgentLaunch({
      type: 'arguments',
      agent: 'claude',
      value: '--host-marker'
    })
    const result = await controller.mutateAgentLaunch({
      type: 'environment-set',
      agent: 'claude',
      name: 'MARKER',
      value: 'host-marker'
    })

    expect(host.agentCmdOverrides?.claude).toBe('/host/claude-wrapper')
    expect(structuredAgentConfiguredArgs('claude', host)).toEqual(['--host-marker'])
    expect(resolveTuiAgentLaunchEnv('claude', host.agentDefaultEnv)).toEqual({
      API_KEY: 'host-secret',
      KEEP: 'host-only',
      MARKER: 'host-marker'
    })
    expect(desktop.agentDefaultArgs?.claude).toBe('--desktop-marker')
    expect(desktop.agentDefaultEnv?.claude).toEqual({ API_KEY: 'desktop-secret' })
    expect(JSON.stringify(result)).not.toContain('host-secret')
    expect(result.environmentNames.claude).toEqual(['API_KEY', 'KEEP', 'MARKER'])
  })

  it('mutates the latest host maps instead of replacing a stale client snapshot', async () => {
    const { controller, host } = fixture()
    controller.getAgentLaunch()
    host.agentDefaultArgs = { ...host.agentDefaultArgs, pi: '--provider host' }
    await Promise.all([
      controller.mutateAgentLaunch({ type: 'arguments', agent: 'claude', value: '--new-claude' }),
      controller.mutateAgentLaunch({ type: 'arguments', agent: 'codex', value: '--new-codex' })
    ])
    await controller.mutateAgentLaunch({
      type: 'environment-set',
      agent: 'claude',
      name: 'API_KEY',
      value: 'replacement'
    })
    await controller.mutateAgentLaunch({
      type: 'environment-remove',
      agent: 'claude',
      name: 'KEEP'
    })
    expect(host.agentDefaultArgs).toMatchObject({
      claude: '--new-claude',
      codex: '--new-codex',
      pi: '--provider host'
    })
    expect(host.agentDefaultEnv?.claude).toEqual({ API_KEY: 'replacement' })
    expect(host.agentCmdOverrides?.codex).toBe('/host/codex')
  })

  it('changes terminal permissions on the host without roundtripping unrelated secrets', async () => {
    const { controller, host } = fixture()
    host.agentDefaultArgs = { claude: '--dangerously-skip-permissions' }
    await controller.mutateAgentLaunch({ type: 'permissions', mode: 'manual' })
    expect(host.agentDefaultArgs?.claude).toBe('')
    expect(host.agentDefaultEnv?.claude).toEqual({ API_KEY: 'host-secret', KEEP: 'host-only' })
    expect(JSON.stringify(controller.getAgentLaunch())).not.toContain('host-only')
  })

  it('clears the host default when disabling that agent and preserves others', async () => {
    const { controller, host } = fixture()
    host.defaultTuiAgent = 'claude'
    host.disabledTuiAgents = ['codex']
    await controller.mutateAgentLaunch({ type: 'availability', agent: 'claude', enabled: false })
    expect(host.defaultTuiAgent).toBeNull()
    expect(host.disabledTuiAgents).toEqual(['codex', 'claude'])
  })

  it('does not expose env values through either new result, while leaving the legacy projection compatible', async () => {
    const { controller } = fixture()
    expect(JSON.stringify(controller.getAgentLaunch())).not.toContain('host-secret')
    expect(controller.get().agentDefaultEnv?.claude?.API_KEY).toBe('host-secret')
    await controller.mutateAgentLaunch({ type: 'command', agent: 'claude', value: '' })
    expect(JSON.stringify(controller.getAgentLaunch())).not.toContain('host-secret')
  })

  it('reports a failed host write instead of returning a successful projection', async () => {
    const { controller, updateSettings, host } = fixture()
    updateSettings.mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(
      controller.mutateAgentLaunch({ type: 'arguments', agent: 'claude', value: '--new' })
    ).rejects.toThrow('disk full')
    expect(host.agentDefaultArgs?.claude).toBe('--host-old')
  })

  it('uses host Windows environment name rules', () => {
    const settings = { agentDefaultEnv: { claude: { Path: 'old', API_KEY: 'keep' } } }
    const updates = agentLaunchSettingsMutationUpdates(
      settings,
      { type: 'environment-set', agent: 'claude', name: 'PATH', value: 'new' },
      'win32'
    )
    expect(updates.agentDefaultEnv?.claude).toEqual({ PATH: 'new', API_KEY: 'keep' })
  })

  it('preserves valid environment names that also name object properties', async () => {
    const { controller, host } = fixture()
    const result = await controller.mutateAgentLaunch({
      type: 'environment-set',
      agent: 'claude',
      name: '__proto__',
      value: 'explicit-value'
    })
    expect(host.agentDefaultEnv?.claude?.['__proto__']).toBe('explicit-value')
    expect(result.environmentNames.claude).toContain('__proto__')
    expect(host.agentDefaultEnv?.claude?.API_KEY).toBe('host-secret')
  })

  it('rejects invalid agents, names, nul bytes, and oversized values', () => {
    for (const mutation of [
      { type: 'arguments', agent: 'unknown', value: '' },
      { type: 'environment-set', agent: 'claude', name: 'BAD NAME', value: '' },
      { type: 'environment-set', agent: 'claude', name: 'KEY', value: '\0' },
      { type: 'arguments', agent: 'claude', value: 'x'.repeat(8193) }
    ]) {
      expect(AgentLaunchSettingsMutation.safeParse(mutation).success).toBe(false)
    }
    expect(
      AgentLaunchSettingsMutation.safeParse({
        type: 'environment-set',
        agent: 'claude',
        name: 'EMPTY',
        value: ''
      }).success
    ).toBe(true)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('settings.getAgentLaunch')).toBe(false)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('settings.mutateAgentLaunch')).toBe(false)
  })
})
