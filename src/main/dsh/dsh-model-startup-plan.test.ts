import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import {
  buildExecutionHostAgentStartupPlan,
  planExecutionHostStartupWithPromptCandidate
} from '../opencode/opencode-model-startup-plan'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: vi.fn() }))
vi.mock('../startup/login-shell-environment', () => ({ resolveLoginShellEnvironment: vi.fn() }))

function scope() {
  return {
    inputs: resolveAgentStartupPlanInputs({
      agent: 'dsh',
      settings: { agentDefaultEnv: { dsh: { PATH: '/chosen/bin', DSH_CONFIG: 'chosen' } } },
      platform: process.platform,
      isRemote: false,
      shell: undefined,
      sessionOptions: { model: 'ark/kimi3', effort: 'high' }
    }),
    cwd: '/project/folder',
    prompt: '',
    accountEnv: { DSH_CONFIG: 'account' }
  }
}

describe('execution-host DSH launch capability', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(resolveCommandOnLocalPath).mockResolvedValue('/chosen/bin/dsh-tui')
    vi.mocked(resolveLoginShellEnvironment).mockResolvedValue({ PATH: '/login/bin' })
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      timedOut: false,
      outputTruncated: false,
      stdout: '  --model <provider/model>  Session model\n  --effort <level>  Session effort\n',
      stderr: ''
    })
  })

  it('probes and pins the execution host CLI with launch environment and folder cwd', async () => {
    const plan = await buildExecutionHostAgentStartupPlan(scope())
    expect(resolveCommandOnLocalPath).toHaveBeenCalledWith(
      'dsh-tui',
      expect.objectContaining({
        cwd: '/project/folder',
        env: expect.objectContaining({ PATH: '/chosen/bin', DSH_CONFIG: 'account' })
      })
    )
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/chosen/bin/dsh-tui', args: ['--help'] })
    )
    expect(plan?.launchCommand).toContain(
      "'/chosen/bin/dsh-tui' '.' '--model' 'ark/kimi3' '--effort' 'high'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'ark/kimi3', effort: 'high' })
  })

  it.each([
    { stdout: 'Usage: dsh-tui [prompt]\n' },
    { stdout: '  --model <provider/model>\n' },
    { stdout: 'example: dsh-tui --model <provider/model> --effort <level>\n' },
    { code: 1 },
    { timedOut: true },
    { outputTruncated: true }
  ])(
    'refuses old, failed, truncated or ambiguous help before creating a launch plan: %j',
    async (change) => {
      vi.mocked(runProcess).mockResolvedValue({
        code: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        stdout: '  --model <provider/model>\n  --effort <level>\n',
        stderr: '',
        ...change
      })
      await expect(buildExecutionHostAgentStartupPlan(scope())).rejects.toMatchObject({
        code: 'capability_unsupported'
      })
    }
  )

  it('also gates the worker startup-plan path', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('disconnected'))
    await expect(
      planExecutionHostStartupWithPromptCandidate({
        ...scope(),
        host: { provesAgentInFront: true }
      })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
  })

  it.each([{ isRemote: true }, { platform: 'other' }])(
    'never probes the client CLI for a different host: %j',
    async (change) => {
      const options = scope()
      if (change.isRemote === true) {
        options.inputs.isRemote = true
      } else {
        options.inputs.platform = 'win32' === process.platform ? 'linux' : 'win32'
      }
      await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
        code: 'capability_unsupported'
      })
      expect(runProcess).not.toHaveBeenCalled()
    }
  )

  it('keeps launches without overrides compatible with old DSH', async () => {
    const options = scope()
    options.inputs.sessionOptions = undefined
    expect((await buildExecutionHostAgentStartupPlan(options))?.launchCommand).toBe('dsh-tui .')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('refuses WSL without probing a different local executable', async () => {
    const options = { ...scope(), isWsl: true }
    await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('refuses a configured wrapper command whose help would not identify the launched TUI', async () => {
    const options = scope()
    options.inputs.cmdOverrides.dsh = 'dsh --profile private-tui'
    await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('refuses unsupported session option shapes instead of silently dropping values', async () => {
    const options = scope()
    options.inputs.sessionOptions = { effort: 'high' }
    await expect(buildExecutionHostAgentStartupPlan(options)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('preserves remote launches without explicit model or effort overrides', async () => {
    const options = scope()
    options.inputs.isRemote = true
    options.inputs.sessionOptions = undefined
    expect((await buildExecutionHostAgentStartupPlan(options))?.launchCommand).toBe('dsh-tui .')
    expect(runProcess).not.toHaveBeenCalled()
  })
})
