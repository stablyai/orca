import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import { probeOpenCodeLaunchCapabilities } from './opencode-launch-capabilities'
import {
  probeOpenCodeModelAvailability,
  resolveOpenCodeDirectModelExecutable
} from './opencode-model-availability'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { buildExecutionHostAgentStartupPlan } from './opencode-model-startup-plan'

vi.mock('../managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('./opencode-launch-capabilities', () => ({ probeOpenCodeLaunchCapabilities: vi.fn() }))
vi.mock('./opencode-model-availability', () => ({
  resolveOpenCodeDirectModelExecutable: vi.fn(),
  probeOpenCodeModelAvailability: vi.fn()
}))
vi.mock('./opencode-launch-model-context', () => ({ probeOpenCodeLaunchModelContext: vi.fn() }))

const preferred = 'opencode/fledge-alpha-free'
const original = JSON.stringify({
  default_agent: 'reviewer',
  providers: { custom: { apiKey: 'placeholder' } },
  agents: { reviewer: { system: 'Review only', model: 'opencode/big-pickle' } }
})
function scope() {
  return {
    inputs: resolveAgentStartupPlanInputs({
      agent: 'opencode',
      settings: {
        agentCmdOverrides: { opencode: '/private/opencode' },
        agentDefaultEnv: { opencode: { OPENCODE_CONFIG_CONTENT: original } }
      },
      platform: process.platform,
      isRemote: false,
      sessionOptions: { model: preferred }
    }),
    cwd: '/private/project',
    prompt: 'Read only',
    hostIdentity: 'host'
  }
}

describe('execution-host OpenCode model startup', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(resolveOpenCodeDirectModelExecutable).mockResolvedValue('/private/opencode')
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version: '2.0.16',
      pluginApi: 'v2',
      promptMode: 'prefill'
    })
    vi.mocked(probeOpenCodeModelAvailability).mockResolvedValue(true)
    vi.mocked(probeOpenCodeLaunchModelContext)
      .mockResolvedValueOnce({
        primaryAgent: 'reviewer',
        availableModels: [preferred],
        primaryModel: 'opencode/big-pickle'
      })
      .mockResolvedValue({
        primaryAgent: 'reviewer',
        availableModels: [preferred],
        primaryModel: preferred
      })
  })

  it('refuses unsupported effort preferences before probing or dropping them', async () => {
    const options = scope()
    options.inputs.sessionOptions = { model: preferred, effort: 'high' }
    await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
    expect(probeOpenCodeLaunchModelContext).not.toHaveBeenCalled()
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
  })

  it('launches current v2 in isolation and keeps one-time model preferences out of resume state', async () => {
    const options = scope()
    const plan = await buildExecutionHostAgentStartupPlan(options)
    expect(plan?.launchCommand).toContain('--standalone')
    expect(plan?.launchCommand).not.toContain('--model')
    expect(plan?.sessionOptions).toEqual({ model: preferred })
    expect(JSON.parse(plan?.env?.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({
      default_agent: 'reviewer',
      model: preferred,
      providers: { custom: { apiKey: 'placeholder' } },
      agents: { reviewer: { system: 'Review only', model: preferred } }
    })
    expect(plan?.launchConfig).toEqual({
      agentCommand: '/private/opencode',
      agentArgs: '',
      agentEnv: { OPENCODE_CONFIG_CONTENT: original }
    })
    expect(options.inputs.agentEnv.OPENCODE_CONFIG_CONTENT).toBe(original)
  })

  it('uses the selected account environment in both authoritative probes', async () => {
    vi.mocked(applyManagedDataAccountEnvironment).mockImplementation((env) => {
      env.XDG_DATA_HOME = '/selected/data'
      env.OPENCODE_DB = 'opencode.db'
    })
    await buildExecutionHostAgentStartupPlan(scope())
    for (const call of vi.mocked(probeOpenCodeLaunchModelContext).mock.calls) {
      expect(call[0].env).toMatchObject({
        XDG_DATA_HOME: '/selected/data',
        OPENCODE_DB: 'opencode.db'
      })
    }
  })

  it('preserves the verified legacy launch route', async () => {
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version: '1.18.30',
      pluginApi: 'v1',
      promptMode: 'submit'
    })
    expect((await buildExecutionHostAgentStartupPlan(scope()))?.launchCommand).toContain('--model')
    expect(probeOpenCodeLaunchModelContext).not.toHaveBeenCalled()
  })

  it('preserves ordinary launches without any private server probe', async () => {
    const options = scope()
    options.inputs.sessionOptions = undefined
    expect((await buildExecutionHostAgentStartupPlan(options))?.launchCommand).not.toContain(
      '--standalone'
    )
    expect(probeOpenCodeLaunchCapabilities).not.toHaveBeenCalled()
  })

  it.each(['--agent build', '--continue', '--server http://localhost'])(
    'refuses current-v2 manual launch arguments %s',
    async (agentArgs) => {
      const options = scope()
      options.inputs.agentArgs = agentArgs
      await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
        code: 'capability_unsupported'
      })
      expect(probeOpenCodeLaunchModelContext).not.toHaveBeenCalled()
    }
  )

  it('refuses unavailable models and mismatched observed model preferences', async () => {
    vi.mocked(probeOpenCodeLaunchModelContext)
      .mockReset()
      .mockResolvedValue({ primaryAgent: 'reviewer', availableModels: [], primaryModel: null })
    await expect(buildExecutionHostAgentStartupPlan(scope())).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
    vi.mocked(probeOpenCodeLaunchModelContext)
      .mockReset()
      .mockResolvedValue({
        primaryAgent: 'reviewer',
        availableModels: [preferred],
        primaryModel: 'opencode/big-pickle'
      })
    await expect(buildExecutionHostAgentStartupPlan(scope())).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
  })

  it('refuses remote and WSL execution before touching the local binary', async () => {
    const options = scope()
    options.inputs.isRemote = true
    await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
    options.inputs.isRemote = false
    await expect(
      buildExecutionHostAgentStartupPlan({ ...options, isWsl: true })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(resolveOpenCodeDirectModelExecutable).not.toHaveBeenCalled()
  })
})
