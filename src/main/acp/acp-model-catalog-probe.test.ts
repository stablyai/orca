import { afterEach, describe, expect, it, vi } from 'vitest'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import {
  createAcpModelCatalogProbe,
  type AcpModelCatalogProbeDeps
} from './acp-model-catalog-probe'
import { AcpSessionRuntime } from './acp-session-runtime'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
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
      resolveCommand: () => '/opt/opencode/bin/opencode',
      probeVersion: async () => true,
      homePath: '/home/user',
      runListing,
      connect
    })
    const success = await probe({ kind: 'opencode', locator: { kind: 'unmanaged' } })
    expect(connect).not.toHaveBeenCalled()
    expect(runListing).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/opt/opencode/bin/opencode',
        args: ['models', '--verbose'],
        env: expect.objectContaining({ OPENCODE_CLIENT: 'acp' })
      }),
      expect.objectContaining({ site: 'opencode-model-catalog-probe' })
    )
    expect(success.models).toEqual([
      { id: 'opencode/big-pickle', label: 'opencode/Big Pickle', isDefault: false, efforts: [] }
    ])
  })

  it('lists nothing for a release that runs no structured chat', async () => {
    const runListing = vi.fn()
    const probe = createAcpModelCatalogProbe(OPENCODE, {
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCommand: () => '/opt/opencode/bin/opencode',
      probeVersion: async () => false,
      runListing
    })
    await expect(probe({ kind: 'opencode', locator: { kind: 'unmanaged' } })).rejects.toThrow(
      /does not run structured chats/
    )
    expect(runListing).not.toHaveBeenCalled()
  })
})
