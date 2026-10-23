import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import {
  createAcpModelCatalogProbe,
  type AcpModelCatalogProbeDeps
} from './acp-model-catalog-probe'
import { AcpSessionRuntime } from './acp-session-runtime'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import { AgentModelCatalogListingStoppedError } from '../native-chat/agent-model-catalog/agent-model-catalog-failures'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'

const GROK = acpLaunchSpecFor('grok')!
// The user's own OpenCode environment, read without the app's managed-account service.
const OPENCODE: AcpLaunchSpec = {
  ...acpLaunchSpecFor('opencode')!,
  account: openCodeAcpAccountBinding(() => ({
    list: () => ({ activeAccountId: null, accounts: [] }),
    restoreOriginalEnvironment: () => {},
    environmentForAccount: () => ({})
  }))
}
const GROK_HOME = { variable: 'GROK_HOME', path: '/homes/grok-a' }

const MODEL_STATE = {
  currentModelId: 'grok-build',
  availableModels: [
    {
      modelId: 'grok-build',
      name: 'Grok Build',
      _meta: {
        supportsReasoningEffort: true,
        // The session's own pick, which must not become a catalog default.
        reasoningEffort: 'low',
        reasoningEfforts: [
          { value: 'low', id: 'fast', label: 'Fast' },
          { value: 'high', id: 'deep', default: true }
        ]
      }
    },
    { modelId: 'grok-mini', name: 'Grok Mini', _meta: { supportsReasoningEffort: true } },
    { modelId: 'grok-chat', name: 'Grok Chat', _meta: {} }
  ]
}

const agents: AcpScriptedAgent[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const agent of agents.splice(0)) {
    agent.close()
  }
})

function scriptedGrok(initializeMeta: Record<string, unknown>): {
  agent: AcpScriptedAgent
  launches: ProviderProcessLaunch[]
  closed: () => number
  deps: AcpModelCatalogProbeDeps
} {
  const agent = new AcpScriptedAgent()
  agents.push(agent)
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: 1, agentCapabilities: {}, _meta: initializeMeta })
  )
  agent.on('x.ai/models/list', (frame) => agent.reply(frame, { result: MODEL_STATE }))
  const launches: ProviderProcessLaunch[] = []
  let closes = 0
  return {
    agent,
    launches,
    closed: () => closes,
    deps: {
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      dataDirectory: '/orca-data',
      resolveLaunchEnv: () => ({ XAI_API_KEY: 'from-settings' }),
      resolveCommand: () => '/opt/grok/bin/grok',
      homePath: '/home/user',
      connect: (launch) => {
        launches.push(launch)
        const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin)
        return {
          initialize: () => runtime.initialize(),
          requestSessionFreeExtension: (method, params) =>
            runtime.requestSessionFreeExtension(method, params),
          close: async () => {
            closes++
            runtime.close()
          }
        }
      }
    }
  }
}

function scriptedOpenCode2(canDelete: boolean): {
  agent: AcpScriptedAgent
  launches: ProviderProcessLaunch[]
  closed: () => number
  deps: AcpModelCatalogProbeDeps & {
    runListing: Mock<NonNullable<AcpModelCatalogProbeDeps['runListing']>>
  }
} {
  const agent = new AcpScriptedAgent()
  agents.push(agent)
  agent.on('initialize', (frame) =>
    agent.reply(frame, {
      protocolVersion: 1,
      agentCapabilities: {
        sessionCapabilities: canDelete ? { delete: {} } : {}
      }
    })
  )
  agent.on('session/new', (frame) =>
    agent.reply(frame, {
      sessionId: 'probe-session',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'opencode/exo-free',
          options: [
            { value: 'opencode/big-pickle', name: 'Big Pickle' },
            { value: 'opencode/exo-free', name: 'Exo Free' }
          ]
        }
      ]
    })
  )
  agent.on('session/delete', (frame) => agent.reply(frame, {}))
  const launches: ProviderProcessLaunch[] = []
  let closes = 0
  return {
    agent,
    launches,
    closed: () => closes,
    deps: {
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveCommand: () => '/opt/opencode/bin/opencode',
      probeVersion: async () => ({ version: '2.0.29' }),
      homePath: '/home/user',
      dataDirectory: '/orca-data',
      runListing: vi.fn<NonNullable<AcpModelCatalogProbeDeps['runListing']>>(),
      connectSession: (launch) => {
        launches.push(launch)
        const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin)
        return {
          initialize: () => runtime.initialize(),
          start: (options) => runtime.start(options),
          deleteSession: (sessionId) => runtime.deleteSession(sessionId),
          close: async () => {
            closes += 1
            runtime.close()
          }
        }
      }
    }
  }
}

describe('ACP model catalog probes', () => {
  it('lists Grok from initialize alone, under its pinned account, and closes the child', async () => {
    const { agent, deps, launches, closed } = scriptedGrok({ modelState: MODEL_STATE })
    const success = await createAcpModelCatalogProbe(GROK, deps)(GROK_HOME)
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize'])
    expect(agent.frames[0]!.params).toMatchObject({
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    })
    expect(launches).toEqual([
      expect.objectContaining({
        command: '/opt/grok/bin/grok',
        args: ['agent', 'stdio'],
        env: expect.objectContaining({ GROK_HOME: '/homes/grok-a', XAI_API_KEY: 'from-settings' })
      })
    ])
    expect(closed()).toBe(1)
    expect(success.models).toEqual([
      {
        id: 'grok-build',
        label: 'Grok Build',
        // `initialize`'s currentModelId is not what a session runs, so it names no default.
        isDefault: false,
        // Grok's option ids, which its effort config option takes, and its own default only.
        efforts: [
          { value: 'fast', label: 'Fast' },
          { value: 'deep', label: 'Deep' }
        ],
        defaultEffort: 'deep'
      },
      {
        id: 'grok-mini',
        label: 'Grok Mini',
        isDefault: false,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => ({
          value,
          label: expect.any(String)
        }))
      },
      { id: 'grok-chat', label: 'Grok Chat', isDefault: false, efforts: [] }
    ])
  })

  it('falls back to x.ai/models/list and never authenticates or opens a session', async () => {
    const { agent, deps } = scriptedGrok({})
    const success = await createAcpModelCatalogProbe(GROK, deps)(GROK_HOME)
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'x.ai/models/list'])
    expect(success.models.map((model) => model.id)).toEqual([
      'grok-build',
      'grok-mini',
      'grok-chat'
    ])
  })

  it('fails, closing the child, when Grok lists nothing', async () => {
    const { agent, deps, closed } = scriptedGrok({})
    agent.on('x.ai/models/list', (frame) => agent.reply(frame, { error: 'not signed in' }))
    await expect(createAcpModelCatalogProbe(GROK, deps)(GROK_HOME)).rejects.toThrow(/did not list/)
    expect(closed()).toBe(1)
    expect(agent.frames.some((frame) => frame.method === 'authenticate')).toBe(false)
  })

  it('lists OpenCode with `models --verbose` under its scrubbed launch env, with no ACP call', async () => {
    const runListing = vi.fn(async () => 'opencode/big-pickle\n{\n  "name": "Big Pickle"\n}\n')
    const connect = vi.fn()
    const probe = createAcpModelCatalogProbe(OPENCODE, {
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      dataDirectory: '/orca-data',
      resolveCommand: () => '/opt/opencode/bin/opencode',
      probeVersion: async () => ({ version: '1.18.35' }),
      homePath: '/home/user',
      runListing,
      connect
    })
    const success = await probe(
      { kind: 'opencode', locator: { kind: 'unmanaged' } },
      { workspacePath: '/work/project' }
    )
    expect(connect).not.toHaveBeenCalled()
    expect(runListing).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/opt/opencode/bin/opencode',
        args: ['models', '--verbose'],
        // Where the project's opencode.json is read, so it lists what a chat there offers.
        cwd: '/work/project',
        env: expect.objectContaining({ OPENCODE_CLIENT: 'acp' })
      }),
      expect.objectContaining({ site: 'opencode-model-catalog-probe' })
    )
    expect(success.models).toEqual([
      { id: 'opencode/big-pickle', label: 'opencode/Big Pickle', isDefault: false, efforts: [] }
    ])
  })

  // Every 2.x release rejects `--verbose`, and its own listings omit providers that report late.
  it('lists OpenCode 2.x from a session it opens and deletes, with no listing command', async () => {
    const { agent, deps, launches } = scriptedOpenCode2(true)
    const success = await createAcpModelCatalogProbe(OPENCODE, deps)(
      { kind: 'opencode', locator: { kind: 'unmanaged' } },
      { workspacePath: '/work/project' }
    )
    expect(agent.frames.map((frame) => frame.method)).toEqual([
      'initialize',
      'session/new',
      'session/delete'
    ])
    // In the asking chat's folder, so OpenCode records no project the person never opened.
    expect(agent.frames[1]!.params).toMatchObject({ cwd: '/work/project' })
    expect(agent.frames[2]!.params).toEqual({ sessionId: 'probe-session' })
    expect(launches).toEqual([expect.objectContaining({ args: ['acp'] })])
    expect(deps.runListing).not.toHaveBeenCalled()
    expect(success.models.map((model) => [model.id, model.label])).toEqual([
      ['opencode/big-pickle', 'Big Pickle'],
      ['opencode/exo-free', 'Exo Free']
    ])
  })

  it('opens no session on an OpenCode 2.x that cannot delete one', async () => {
    const { agent, deps } = scriptedOpenCode2(false)
    await expect(
      createAcpModelCatalogProbe(OPENCODE, deps)(
        { kind: 'opencode', locator: { kind: 'unmanaged' } },
        { workspacePath: '/work/project' }
      )
    ).rejects.toThrow(/cannot delete a session/)
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize'])
  })

  // `omp acp` advertises no delete, so its listing session goes to a folder the probe removes.
  it('lists OMP from a session kept in a folder it removes, in the chat folder', async () => {
    const { agent, deps, launches } = scriptedOpenCode2(false)
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-omp-listing-'))
    try {
      const success = await createAcpModelCatalogProbe(acpLaunchSpecFor('omp')!, {
        ...deps,
        dataDirectory,
        resolveCommand: () => '/opt/omp/bin/omp',
        probeVersion: async () => ({ version: '18.12.2' })
      })(
        { variable: 'PI_CODING_AGENT_DIR', path: '/homes/omp' },
        { workspacePath: '/work/project' }
      )
      expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize', 'session/new'])
      expect(agent.frames[1]!.params).toMatchObject({ cwd: '/work/project' })
      const root = join(dataDirectory, 'acp-listing-sessions', 'omp')
      expect(launches).toEqual([
        expect.objectContaining({
          args: ['acp', '--session-dir', expect.stringMatching(/run-/)]
        })
      ])
      expect(dirname(launches[0]!.args[2]!)).toBe(root)
      expect(await readdir(root)).toEqual([])
      expect(success.models.map((model) => model.id)).toEqual([
        'opencode/big-pickle',
        'opencode/exo-free'
      ])
    } finally {
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })

  it('opens no session on OpenCode 2.x without a chat folder, as at a prewarm', async () => {
    const { agent, deps, launches } = scriptedOpenCode2(true)
    const probeVersion = vi.fn(deps.probeVersion)
    await expect(
      createAcpModelCatalogProbe(OPENCODE, { ...deps, probeVersion })({
        kind: 'opencode',
        locator: { kind: 'unmanaged' }
      })
    ).rejects.toBeInstanceOf(AgentModelCatalogListingStoppedError)
    expect(launches).toEqual([])
    expect(agent.frames).toEqual([])
    expect(probeVersion).not.toHaveBeenCalled()
  })

  it('keeps the models, and says so, when OpenCode 2.x refuses to delete the listing session', async () => {
    const { agent, deps } = scriptedOpenCode2(true)
    agent.on('session/delete', (frame) => agent.fail(frame, -32603, 'locked'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const success = await createAcpModelCatalogProbe(OPENCODE, deps)(
      { kind: 'opencode', locator: { kind: 'unmanaged' } },
      { workspacePath: '/work/project' }
    )
    expect(success.models).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(
      '[acp-model-catalog] opencode kept its listing session:',
      expect.anything()
    )
    warn.mockRestore()
  })

  // OpenCode may already have saved the session it never named; nothing is left to delete it by.
  it('stops a listing cut off while OpenCode 2.x creates its session, without deleting', async () => {
    const { agent, deps, closed } = scriptedOpenCode2(true)
    agent.on('session/new', () => {})
    const stop = new AbortController()
    const listing = createAcpModelCatalogProbe(OPENCODE, deps)(
      { kind: 'opencode', locator: { kind: 'unmanaged' } },
      { workspacePath: '/work/project', signal: stop.signal }
    )
    await vi.waitFor(() =>
      expect(agent.frames.map((frame) => frame.method)).toContain('session/new')
    )
    stop.abort()
    await expect(listing).rejects.toThrow(/listing stopped/)
    expect(closed()).toBe(1)
    expect(agent.frames.map((frame) => frame.method)).not.toContain('session/delete')
  })

  it('asks an OpenCode 2 chat nothing, not even its version, without a chat folder', async () => {
    const { deps, launches } = scriptedOpenCode2(true)
    const probeVersion = vi.fn(deps.probeVersion)
    const spec = { ...acpLaunchSpecFor('opencode2')!, account: OPENCODE.account }
    await expect(
      createAcpModelCatalogProbe(spec, { ...deps, probeVersion })({
        kind: 'opencode',
        locator: { kind: 'unmanaged' }
      })
    ).rejects.toBeInstanceOf(AgentModelCatalogListingStoppedError)
    expect(probeVersion).not.toHaveBeenCalled()
    expect(launches).toEqual([])
  })

  it('lists nothing for a release that runs no structured chat', async () => {
    const runListing = vi.fn()
    const probe = createAcpModelCatalogProbe(OPENCODE, {
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      dataDirectory: '/orca-data',
      resolveCommand: () => '/opt/opencode/bin/opencode',
      probeVersion: async () => ({ version: '1.0.0' }),
      runListing
    })
    await expect(
      probe(
        { kind: 'opencode', locator: { kind: 'unmanaged' } },
        { workspacePath: '/work/project' }
      )
    ).rejects.toThrow(/does not run structured chats/)
    expect(runListing).not.toHaveBeenCalled()
  })
})
