import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentCliMinimumVersion } from '../agent-launch/preflight/agent-cli-minimum-version'
import { compareAppVersions } from '../../shared/app-lifecycle/identity/app-version'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { createAcpStructuredLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { ACP_LAUNCH_SPECS, acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import {
  agentSessionHoldsProviderConversation,
  agentSessionNeverStarted
} from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { pickAgentSessionOption } from '../runtime/agent-session/records/agent-session-record-options'
import { isAgentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import { modelNamesServingAgent } from '../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import { structuredAgentSessionSeedCatalog } from '../../shared/agent-session/options/model-catalog/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../shared/agent-session/options/structured-agent-session-options'
import {
  canSetStructuredAgentSessionOption,
  structuredAgentSessionOptionSnapshot
} from '../../shared/agent-session/options/view/structured-agent-session-option-snapshot'
import { OURO_LAUNCH_SPEC, parseOuroAgentListing } from './ouro-acp-launch-spec'

// The shape `ouro status --json` prints (0.1.0-alpha.1625), cut to what the listing reads.
function status(agents: unknown[]): string {
  return JSON.stringify(
    {
      overview: { daemon: 'running', health: 'ok', version: '0.1.0-alpha.1625' },
      workers: [{ agent: 'ada', worker: 'private-runtime', status: 'stopped' }],
      senses: [],
      agents,
      providers: []
    },
    null,
    2
  )
}

describe('the Ouro agent listing', () => {
  it('lists each enabled agent this machine serves, named with a capital', () => {
    const stdout = status([
      { name: 'ada', enabled: true, homeState: 'here', homeMachine: 'desk (0123abcd)' },
      { name: 'atlas', enabled: true, homeState: 'here', homeMachine: 'desk (0123abcd)' },
      { name: 'wanderer', enabled: true, homeState: 'fallback', homeMachine: 'laptop (89ef)' }
    ])
    expect(parseOuroAgentListing(stdout)).toEqual([
      { id: 'ada', label: 'Ada', isDefault: false, efforts: [] },
      { id: 'atlas', label: 'Atlas', isDefault: false, efforts: [] },
      { id: 'wanderer', label: 'Wanderer', isDefault: false, efforts: [] }
    ])
  })

  it('leaves out disabled agents, those at home elsewhere, and rows it cannot read', () => {
    const stdout = status([
      { name: 'ada', enabled: true, homeState: 'here' },
      { name: 'sleeper', enabled: false, homeState: 'here' },
      { name: 'traveller', enabled: true, homeState: 'elsewhere', homeMachine: 'laptop (89ef)' },
      { name: 'stray', enabled: true, homeState: 'unclaimed' },
      { name: '', enabled: true, homeState: 'here' },
      { enabled: true, homeState: 'here' },
      'ada',
      null
    ])
    expect(parseOuroAgentListing(stdout).map((model) => model.id)).toEqual(['ada'])
  })

  it.each([
    [
      'daemon unavailable',
      { ok: false, error: 'daemon unavailable', socketPath: '/tmp/ouroboros-daemon.sock' }
    ],
    [
      'daemon timeout',
      {
        ok: false,
        error: 'daemon timeout',
        classification: 'timeout',
        code: 'ETIMEDOUT',
        socketPath: '/tmp/ouroboros-daemon.sock',
        detail: 'no reply in 5000ms'
      }
    ]
  ])('fails with the daemon’s own reason, and points at `ouro up`, on %s', (error, body) => {
    expect(() => parseOuroAgentListing(JSON.stringify(body))).toThrow(
      `ouro status: ${error}. Run \`ouro up\` to start the daemon.`
    )
  })

  it.each([
    ['output that is not JSON', 'Segmentation fault'],
    ['empty output', ''],
    ['no agents list', JSON.stringify({ overview: { daemon: 'stopped' } })],
    ['agents that is not a list', JSON.stringify({ agents: { ada: true } })],
    ['a bare list', JSON.stringify([{ name: 'ada', enabled: true, homeState: 'here' }])],
    ['a failure with no reason', JSON.stringify({ ok: false })]
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

  it('serves the picked agent, and with none picked leaves acp-serve to refuse on its own', () => {
    const base = { fullAccess: false, pluginDirs: [] }
    expect(OURO_LAUNCH_SPEC.args({ ...base, model: 'ada' })).toEqual([
      'acp-serve',
      '--agent',
      'ada'
    ])
    expect(OURO_LAUNCH_SPEC.args({ ...base, fullAccess: true, model: 'ada' })).toEqual([
      'acp-serve',
      '--agent',
      'ada'
    ])
    expect(OURO_LAUNCH_SPEC.args(base)).toEqual(['acp-serve'])
    expect(OURO_LAUNCH_SPEC.args({ ...base, model: '' })).toEqual(['acp-serve'])
  })

  it('names ~/AgentBundles as the account, unless the launch environment moves it', async () => {
    const resolve = OURO_LAUNCH_SPEC.account.resolve
    await expect(resolve({ launchEnv: {}, stateDirectory: '/state' })).resolves.toEqual({
      variable: 'OURO_AGENT_BUNDLES',
      path: join(homedir(), 'AgentBundles')
    })
    await expect(
      resolve({ launchEnv: { OURO_AGENT_BUNDLES: '/srv/bundles' }, stateDirectory: '/state' })
    ).resolves.toEqual({ variable: 'OURO_AGENT_BUNDLES', path: '/srv/bundles' })
  })

  it('looks for the launcher in ~/.ouro-cli/bin', () => {
    expect(OURO_LAUNCH_SPEC.installDirectories({ env: {}, homePath: '/home/user' })).toEqual([
      join('/home/user', '.ouro-cli', 'bin')
    ])
  })

  it('needs the first release that reopens saved chats', () => {
    const floor = agentCliMinimumVersion('0.1.0-alpha.1631', OURO_LAUNCH_SPEC.minimumVersions ?? [])
    expect(floor).toBe('0.1.0-alpha.1632')
    expect(compareAppVersions('0.1.0-alpha.1631', floor!)).toBeLessThan(0)
    expect(compareAppVersions('0.1.0-alpha.1632', floor!)).toBe(0)
    expect(compareAppVersions('0.1.0-alpha.10000', floor!)).toBeGreaterThan(0)
  })
})

describe('an Ouro chat launch', () => {
  function launch(
    record: Partial<AgentSessionRecord>,
    options: { instructions?: string; version?: string } = {}
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
      probeVersion: async () => ({ version: options.version ?? '0.1.0-alpha.1632' }),
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

  it('refuses a CLI older than the first release that reopens saved chats', async () => {
    await expect(
      launch({ options: { model: 'ada' } }, { version: '0.1.0-alpha.1631' })
    ).rejects.toThrow('Chats need 0.1.0-alpha.1632 or newer.')
  })

  it('runs acp-serve for the chat’s agent, leaving the environment as Ouro reads it', async () => {
    const resolved = await launch({ options: { model: 'ada' } })
    expect(resolved.args).toEqual(['acp-serve', '--agent', 'ada'])
    expect(resolved.env.OURO_AGENT_BUNDLES).toBeUndefined()
  })

  it('serves the same agent when the chat reopens its conversation', async () => {
    const resolved = await launch({ ...reopened, options: { model: 'ada' } })
    expect(resolved.args).toEqual(['acp-serve', '--agent', 'ada'])
  })

  it('refuses a chat with standing instructions, which Ouro has no way to take', async () => {
    await expect(
      launch({ options: { model: 'ada' } }, { instructions: 'You are a bot in Orca.' })
    ).rejects.toThrow(/cannot take this chat's standing instructions/)
  })
})

describe('switching agent on an Ouro chat', () => {
  const ADA = { id: 'ada', label: 'Ada', isDefault: false, efforts: [] }
  const ATLAS = { id: 'atlas', label: 'Atlas', isDefault: false, efforts: [] }

  function picker(sessionNeverStarted: boolean, holdsProviderConversation: boolean) {
    const seed = structuredAgentSessionSeedCatalog('ouro')
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('ouro', seed),
      seed,
      {
        models: [ADA, ATLAS],
        listedModelIds: ['ada', 'atlas'],
        current: { model: 'ada' },
        sessionNeverStarted,
        holdsProviderConversation
      }
    )
    const model = structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === 'model')
    return { model, canSwitch: canSetStructuredAgentSessionOption(state, 'model', 'atlas') }
  }

  it('is offered before the chat starts', () => {
    const { model, canSwitch } = picker(true, false)
    expect(model).toMatchObject({ settable: true })
    expect(canSwitch).toBe(true)
  })

  // A launch can fail before session/new answers, say on a removed agent: switching is the way out.
  it('stays open after a launch that no agent took up, as the host allows', () => {
    const { model, canSwitch } = picker(false, false)
    expect(model).toMatchObject({ settable: true })
    expect(canSwitch).toBe(true)
  })

  it('is shown read-only once an agent holds the conversation, naming that agent', () => {
    const { model, canSwitch } = picker(false, true)
    expect(model).toMatchObject({ settable: false, disabledReason: 'set-when-session-starts' })
    expect(model?.kind).toMatchObject({ currentValue: 'ada' })
    expect(canSwitch).toBe(false)
  })

  const pick = (record: AgentSessionRecord, value: string) =>
    pickAgentSessionOption(record, {
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      key: 'model',
      value,
      models: undefined,
      now: 2
    })
  const chat = (
    providerHandleChain: AgentSessionRecord['providerHandleChain']
  ): AgentSessionRecord => ({
    ...agentSessionRecordFixture(),
    provider: 'ouro',
    options: { model: 'ada' },
    providerHandleChain
  })
  const held = [
    {
      linkId: 'link-1',
      handle: { transport: 'acp', agent: 'ouro', nativeId: 'ouro-session-1' },
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1
    }
  ] as const satisfies AgentSessionRecord['providerHandleChain']

  it('is refused by the host once an agent holds the conversation', () => {
    let refusal: unknown
    try {
      pick(chat([...held]), 'atlas')
    } catch (error) {
      refusal = error
    }
    expect(isAgentSessionRefusalError(refusal)).toBe(true)
    expect(refusal).toMatchObject({
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' },
        message: expect.stringContaining('stays with ada')
      }
    })
    expect(pick(chat([...held]), 'ada').options).toEqual({ model: 'ada' })
  })

  it('is saved by the host while no agent holds a conversation yet, even after a launch', () => {
    expect(pick(chat([]), 'atlas').options).toEqual({ model: 'atlas' })
    // The fixture's lease is live at fence 7: the chat launched, and no agent took it up.
    expect(agentSessionNeverStarted(chat([]))).toBe(false)
  })

  it('reads the same fact on both sides: a minted handle', () => {
    expect(agentSessionHoldsProviderConversation(chat([]))).toBe(false)
    expect(agentSessionHoldsProviderConversation(chat([...held]))).toBe(true)
  })

  it('is left open for agents whose load restores the model', () => {
    const omp = { ...chat([...held]), provider: 'omp' }
    expect(pick(omp, 'anthropic/claude-sonnet').options).toEqual({
      model: 'anthropic/claude-sonnet'
    })
  })

  it('is locked for exactly the agents whose reopen carries the model', () => {
    for (const spec of ACP_LAUNCH_SPECS) {
      expect([spec.agent, modelNamesServingAgent(spec.agent)]).toEqual([
        spec.agent,
        spec.reopensWithModel === true
      ])
    }
  })
})
