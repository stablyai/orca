import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import { antigravityHostAccountHome } from '../../antigravity/antigravity-host-acp'
import { createAcpModelCatalogProbe } from './acp-model-catalog-probe'
import { acpModelCatalogDiscovery } from '../../runtime/agent-session/model-catalog/structured-agent-model-catalog-discovery'
import { structuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import { structuredAgentHostLaunchSources } from '../../runtime/agent-session/launch/structured-agent-launch-support'
import { createStructuredAgentEnvironmentResolvers } from '../../runtime/agent-session/environment/structured-agent-shell-environment'

describe('ACP model catalog probe for Antigravity', () => {
  it('exposes probe discovery for Antigravity even though managed runtime lists only in-session', () => {
    const environment = createStructuredAgentEnvironmentResolvers({
      prewarm: false,
      processEnvironment: {},
      resolveShellEnvironmentPolicy: () => ({ inheritAll: false, names: [] })
    })
    const discovery = acpModelCatalogDiscovery(ANTIGRAVITY_LAUNCH_SPEC, {
      deps: {
        stateDirectory: '/state',
        resolveWorkspacePath: async () => '/workspace',
        resolveAgentAccountHome: async () => ({
          variable: 'GEMINI_HOME',
          path: '/state/antigravity-chat'
        }),
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: async () => ({ account: 'system' }),
        resolveCodexAccountKind: () => 'system',
        resolveEnvironment: async () => ({}),
        resolveShellEnvironmentPolicy: () => ({ inheritAll: false, names: [] })
      },
      environment
    })

    expect(discovery.kind).toBe('probe')
    if (discovery.kind === 'probe') {
      expect(discovery.listingNamesConfiguredModel).toBe(false)
    }
  })

  it('probes `agy models` for host account homes while scrubbing inherited API keys', async () => {
    const runListing = vi.fn(async () =>
      [
        'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
        'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
        'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
        'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
        'gemini-4-hydrogen-max\tGemini 4 Hydrogen (Max)',
        'gemini-pro-orchestrator\tOrchestrator (Carbon)'
      ].join('\n')
    )
    const probeVersion = vi.fn(async () => ({ version: '1.5.8' }))
    const probe = createAcpModelCatalogProbe(ANTIGRAVITY_LAUNCH_SPEC, {
      dataDirectory: '/state',
      homePath: '/Users/tester',
      resolveEnvironment: async () => ({
        PATH: '/usr/local/bin',
        GEMINI_API_KEY: 'secret-gemini',
        GOOGLE_API_KEY: 'secret-google'
      }),
      resolveCommand: () => '/usr/local/bin/agy',
      probeVersion,
      runListing
    })

    const listing = await probe(antigravityHostAccountHome('/Users/tester'))
    expect(probeVersion).toHaveBeenCalledTimes(1)
    expect(runListing).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/usr/local/bin/agy',
        args: ['models'],
        envToDelete: expect.arrayContaining(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])
      }),
      expect.objectContaining({ site: 'antigravity-model-catalog-probe' })
    )
    expect(listing.models).toEqual([
      {
        id: 'gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen',
        isDefault: false,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Max' }
        ]
      },
      {
        id: 'gemini-pro-orchestrator',
        label: 'Orchestrator (Carbon)',
        isDefault: false,
        efforts: []
      }
    ])
  })

  it('rejects managed account homes before probing version or spawning agy', async () => {
    const resolveEnvironment = vi.fn(async () => ({ PATH: '/usr/local/bin' }))
    const probeVersion = vi.fn(async () => ({ version: '1.5.8' }))
    const runListing = vi.fn(async () => '')
    const probe = createAcpModelCatalogProbe(ANTIGRAVITY_LAUNCH_SPEC, {
      dataDirectory: '/state',
      homePath: '/Users/tester',
      resolveEnvironment,
      probeVersion,
      runListing
    })

    const managedHome = await ANTIGRAVITY_LAUNCH_SPEC.account.resolve({
      launchEnv: {},
      stateDirectory: '/state'
    })
    await expect(probe(managedHome)).rejects.toThrow(
      'the Antigravity server lists its models only in a signed-in session'
    )
    expect(resolveEnvironment).not.toHaveBeenCalled()
    expect(probeVersion).not.toHaveBeenCalled()
    expect(runListing).not.toHaveBeenCalled()
  })

  it('keeps managed account home isolated when ownAccount is requested during reads and host sign-in', async () => {
    const meta = structuredAgentRuntimeMetadata('antigravity')!
    const hostLaunchEnvironment = vi.fn(async () => ({ HOME: '/Users/tester' }))
    const home = await meta.resolveAccountHome(
      {
        launchEnv: {},
        location: null,
        purpose: 'read',
        ownAccount: true,
        workspacePath: null
      },
      {
        getClaudeConfigDirectory: () => '/claude',
        prepareCodexLaunchHome: async () => '/codex',
        readCodexLaunchHome: async () => '/codex',
        workspaceTrustSettings: () => ({}),
        workspaceTrustRepoDecision: () => undefined,
        stateDirectory: '/state',
        hostLaunchEnvironment,
        hostSettings: () => ({})
      }
    )

    expect(hostLaunchEnvironment).not.toHaveBeenCalled()
    expect(home).toEqual({
      variable: 'GEMINI_HOME',
      path: join('/state', 'antigravity-chat')
    })

    const resolveStructuredAgentAccountHome = vi.fn(async () => home)
    const controller = new AbortController()
    await structuredAgentHostLaunchSources(
      'antigravity',
      {
        requireStore: () => ({
          getSettings: () => ({
            agentDefaultEnv: {},
            nativeChatInheritShellEnvironment: false,
            nativeChatShellEnvironmentVariables: []
          })
        }),
        resolveStructuredAgentAccountHome
      },
      controller.signal
    )
    expect(resolveStructuredAgentAccountHome).toHaveBeenCalledWith('antigravity', {
      ownAccount: true
    })
  })
})
