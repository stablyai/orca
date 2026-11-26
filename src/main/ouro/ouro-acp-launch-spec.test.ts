import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { createAcpStructuredLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { OURO_LAUNCH_SPEC, parseOuroAgentListing } from './ouro-acp-launch-spec'

// The shape `ouro status --json` prints (0.1.0-alpha.1625), cut to what the listing reads.
function status(agents: unknown[]): string {
  return JSON.stringify(
    {
      overview: { daemon: 'running', health: 'ok', version: '0.1.0-alpha.1625' },
      workers: [{ agent: 'slugger', worker: 'private-runtime', status: 'stopped' }],
      senses: [],
      agents,
      providers: []
    },
    null,
    2
  )
}

describe('the Ouro agent listing', () => {
  it('lists each enabled agent whose home is this machine, named with a capital', () => {
    const stdout = status([
      { name: 'slugger', enabled: true, homeState: 'here', homeMachine: 'desk (0123abcd)' },
      { name: 'ouroboros', enabled: true, homeState: 'here', homeMachine: 'desk (0123abcd)' }
    ])
    expect(parseOuroAgentListing(stdout)).toEqual([
      { id: 'slugger', label: 'Slugger', isDefault: false, efforts: [] },
      { id: 'ouroboros', label: 'Ouroboros', isDefault: false, efforts: [] }
    ])
  })

  it('leaves out disabled agents, those at home elsewhere, and rows it cannot read', () => {
    const stdout = status([
      { name: 'slugger', enabled: true, homeState: 'here' },
      { name: 'sleeper', enabled: false, homeState: 'here' },
      { name: 'traveller', enabled: true, homeState: 'elsewhere', homeMachine: 'laptop (89ef)' },
      { name: 'stray', enabled: true, homeState: 'unclaimed' },
      { name: '', enabled: true, homeState: 'here' },
      { enabled: true, homeState: 'here' },
      'slugger',
      null
    ])
    expect(parseOuroAgentListing(stdout).map((model) => model.id)).toEqual(['slugger'])
  })

  it.each([
    ['output that is not JSON', 'ouro: daemon not running'],
    ['empty output', ''],
    ['no agents list', JSON.stringify({ overview: { daemon: 'stopped' } })],
    ['agents that is not a list', JSON.stringify({ agents: { slugger: true } })],
    ['a bare list', JSON.stringify([{ name: 'slugger', enabled: true, homeState: 'here' }])]
  ])('lists none from %s', (_case, stdout) => {
    expect(parseOuroAgentListing(stdout)).toEqual([])
  })
})

describe('the Ouro launch', () => {
  it('is registered, and lists agents with `ouro status --json`', () => {
    expect(acpLaunchSpecFor('ouro')).toBe(OURO_LAUNCH_SPEC)
    expect(OURO_LAUNCH_SPEC.modelDiscovery).toMatchObject({
      kind: 'command',
      args: ['status', '--json'],
      listingNamesConfiguredModel: false
    })
  })

  it('serves the picked agent, and leaves an unpicked one to acp-serve', () => {
    const base = { fullAccess: false, pluginDirs: [] }
    expect(OURO_LAUNCH_SPEC.args({ ...base, model: 'slugger' })).toEqual([
      'acp-serve',
      '--agent',
      'slugger'
    ])
    expect(OURO_LAUNCH_SPEC.args({ ...base, fullAccess: true, model: 'slugger' })).toEqual([
      'acp-serve',
      '--agent',
      'slugger'
    ])
    expect(OURO_LAUNCH_SPEC.args(base)).toEqual(['acp-serve'])
    expect(OURO_LAUNCH_SPEC.args({ ...base, model: '' })).toEqual(['acp-serve'])
  })

  it('looks for the launcher in ~/.ouro-cli/bin', () => {
    expect(OURO_LAUNCH_SPEC.installDirectories({ env: {}, homePath: '/home/user' })).toEqual([
      '/home/user/.ouro-cli/bin'
    ])
  })
})

describe('an Ouro chat launch', () => {
  function launch(
    record: Partial<AgentSessionRecord>,
    options: { instructions?: string } = {}
  ): ReturnType<ReturnType<typeof createAcpStructuredLaunchResolver>> {
    const full: AgentSessionRecord = {
      ...agentSessionRecordFixture(),
      provider: 'ouro',
      providerHandleChain: [],
      accountHome: { variable: 'OURO_AGENT_BUNDLES', path: '/home/user/AgentBundles' },
      ...record
    }
    const resolve = createAcpStructuredLaunchResolver(OURO_LAUNCH_SPEC, {
      store: { getRecord: () => full, pinLaunchDirectory: vi.fn() },
      savedSession: { hasProviderTurn: async () => false },
      resolveWorkspacePath: async () => '/home/user/project',
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveLaunchEnv: () => ({}),
      resolveCommand: (command) => `/resolved/${command}`,
      inheritedEnv: {},
      dataDirectory: '/home/user/orca-data',
      probeVersion: async () => ({ version: '0.1.0-alpha.1625' }),
      ...(options.instructions === undefined
        ? {}
        : { resolveInstructions: async () => options.instructions ?? null })
    })
    return resolve({
      identity: {
        sessionId: 'session-ouro',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'ouro',
        providerHandle: null
      }
    })
  }

  const reopened: Partial<AgentSessionRecord> = {
    providerHandleChain: [
      {
        linkId: 'link-1',
        handle: { transport: 'acp', agent: 'ouro', nativeId: 'ouro-session-1' },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  }

  it('runs acp-serve for the chat’s agent, leaving the environment as Ouro reads it', async () => {
    const resolved = await launch({ options: { model: 'slugger' } })
    expect(resolved.args).toEqual(['acp-serve', '--agent', 'slugger'])
    expect(resolved.env.OURO_AGENT_BUNDLES).toBeUndefined()
  })

  it('serves the same agent when the chat reopens its conversation', async () => {
    const resolved = await launch({ ...reopened, options: { model: 'slugger' } })
    expect(resolved.args).toEqual(['acp-serve', '--agent', 'slugger'])
  })

  it('refuses a chat with standing instructions, which Ouro has no way to take', async () => {
    await expect(
      launch({ options: { model: 'slugger' } }, { instructions: 'You are a bot in Orca.' })
    ).rejects.toThrow(/cannot take this chat's standing instructions/)
  })
})
