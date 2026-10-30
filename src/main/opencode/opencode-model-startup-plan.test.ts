import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import { probeOpenCodeLaunchCapabilities } from './opencode-launch-capabilities'
import { resolveOpenCodeDirectModelExecutable } from './opencode-model-executable'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { buildExecutionHostAgentStartupPlan } from './opencode-model-startup-plan'
import {
  OPENCODE_MODEL_CONFIG_REFUSAL,
  OPENCODE_MODEL_TRANSPORT_REFUSAL,
  OPENCODE_MODEL_VERSION_REFUSAL
} from '../../shared/agent-launch-model-preferences'

vi.mock('../managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('./opencode-launch-capabilities', () => ({ probeOpenCodeLaunchCapabilities: vi.fn() }))
vi.mock('./opencode-model-executable', () => ({
  resolveOpenCodeDirectModelExecutable: vi.fn()
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
        agentCmdOverrides: {},
        agentDefaultEnv: { opencode: { OPENCODE_CONFIG_CONTENT: original } }
      },
      platform: process.platform,
      isRemote: false,
      shell: undefined,
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
    vi.mocked(probeOpenCodeLaunchModelContext).mockResolvedValue({ primaryAgent: 'reviewer' })
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

  it.each(['2.0.16', '2.0.19', '2.1.4'])(
    'launches v2 %s in isolation and keeps one-time model preferences out of resume state',
    async (version) => {
      vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
        version,
        pluginApi: 'v2',
        promptMode: 'prefill'
      })
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
        agentCommand: 'opencode',
        agentArgs: '',
        agentEnv: { OPENCODE_CONFIG_CONTENT: original }
      })
      expect(options.inputs.agentEnv.OPENCODE_CONFIG_CONTENT).toBe(original)
    }
  )

  it('uses the selected account environment in its single primary-agent probe', async () => {
    vi.mocked(applyManagedDataAccountEnvironment).mockImplementation((env) => {
      env.XDG_DATA_HOME = '/selected/data'
      env.OPENCODE_DB = 'opencode.db'
    })
    await buildExecutionHostAgentStartupPlan(scope())
    expect(probeOpenCodeLaunchModelContext).toHaveBeenCalledOnce()
    for (const call of vi.mocked(probeOpenCodeLaunchModelContext).mock.calls) {
      expect(call[0].env).toMatchObject({
        XDG_DATA_HOME: '/selected/data',
        OPENCODE_DB: 'opencode.db'
      })
    }
  })

  it.each(['1.18.30', '1.18.35', '1.19.4'])(
    'launches legacy %s with the requested model flag and no catalog probe',
    async (version) => {
      vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
        version,
        pluginApi: 'v1',
        promptMode: 'submit'
      })
      expect((await buildExecutionHostAgentStartupPlan(scope()))?.launchCommand).toContain(
        '--model'
      )
      expect(probeOpenCodeLaunchModelContext).not.toHaveBeenCalled()
    }
  )

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
        code: 'capability_unsupported',
        message: OPENCODE_MODEL_TRANSPORT_REFUSAL
      })
      expect(probeOpenCodeLaunchModelContext).not.toHaveBeenCalled()
    }
  )

  it('keeps the v2 overlay when primary metadata is unavailable', async () => {
    vi.mocked(probeOpenCodeLaunchModelContext).mockResolvedValue(null)
    const plan = await buildExecutionHostAgentStartupPlan(scope())
    expect(plan?.launchCommand).not.toContain('--model')
    expect(JSON.parse(plan?.env?.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({
      ...JSON.parse(original),
      model: preferred
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

  it.each([
    '1.18.29',
    '1.20.0-beta.1',
    '2.0.12',
    '2.0.13',
    '2.0.14',
    '2.0.15',
    '2.0.17',
    '2.0.18',
    '2.1.5-beta.1',
    '3.0.0',
    null
  ])('refuses unverified version %s before model probing', async (version) => {
    vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
      version,
      pluginApi: 'v2',
      promptMode: 'prefill'
    })
    await expect(buildExecutionHostAgentStartupPlan(scope())).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: OPENCODE_MODEL_VERSION_REFUSAL
    })
    expect(probeOpenCodeLaunchModelContext).not.toHaveBeenCalled()
    expect(resolveOpenCodeDirectModelExecutable).not.toHaveBeenCalled()
  })

  it('keeps invalid inline configuration guidance separate from a version refusal', async () => {
    const options = scope()
    options.inputs.agentEnv.OPENCODE_CONFIG_CONTENT = '{'
    await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
      code: 'capability_unsupported',
      message: OPENCODE_MODEL_CONFIG_REFUSAL
    })
  })

  it('resolves the default bare launch command through the execution host', async () => {
    await buildExecutionHostAgentStartupPlan(scope())
    expect(resolveOpenCodeDirectModelExecutable).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'opencode' })
    )
  })

  it.each(['blank-model', 'effort-only'])(
    'refuses invalid preferences before probing',
    async (scenario) => {
      const options = scope()
      options.inputs.sessionOptions =
        scenario === 'blank-model' ? { model: '' } : { effort: 'high' }
      await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
        code: 'capability_unsupported'
      })
      expect(resolveOpenCodeDirectModelExecutable).not.toHaveBeenCalled()
    }
  )
})
