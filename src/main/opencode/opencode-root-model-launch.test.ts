import { beforeEach, expect, it, vi } from 'vitest'
import { prepareOpenCodePtyLaunch } from './opencode-pty-launch'
import { quoteStartupArg } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { OPENCODE_STARTUP_PROMPT_BODY_ENV } from '../../shared/agent-launch/startup/opencode-startup-prompt'

const run = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: run }))
vi.mock('../ipc/command-path/command-path-resolver', () => ({
  resolveCommandOnLocalPath: async () => '/usr/local/bin/opencode'
}))
vi.mock('./opencode-launch-model-context', () => ({
  probeOpenCodeLaunchModelContext: async () => ({ primaryAgent: 'build' })
}))
vi.mock('../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { endpointFilePath: null }
}))

const launch = (version: string, command: string, envToDelete: string[] = []) => {
  run.mockResolvedValue({ code: 0, stdout: version, timedOut: false })
  return prepareOpenCodePtyLaunch({
    command,
    env: { OPENCODE_CONFIG_CONTENT: '{"autoupdate":false}' },
    envToDelete,
    cwd: `/repo/${version}`,
    isFreshLaunch: true,
    shell: 'posix'
  }).then((result) => ({ ...result, envToDelete }))
}

beforeEach(() => run.mockReset())

it('keeps the overlay when the caller asked to drop inherited OpenCode config', async () => {
  const result = await launch('2.0.21', "opencode '--model' 'opencode/big-pickle'", [
    'OPENCODE_CONFIG_CONTENT'
  ])
  expect(JSON.parse(result.env?.OPENCODE_CONFIG_CONTENT ?? '')).toMatchObject({
    model: 'opencode/big-pickle'
  })
  expect(result.envToDelete).not.toContain('OPENCODE_CONFIG_CONTENT')
})

it('rewrites a PowerShell launch whose prompt only the env body can identify', async () => {
  run.mockResolvedValue({ code: 0, stdout: '2.0.21', timedOut: false })
  const prompt = 'Use "a;b"\nthen run `pnpm test`'
  const tail = ` --prompt ${quoteStartupArg(prompt, 'powershell')}`
  const result = await prepareOpenCodePtyLaunch({
    command: `opencode '--model' 'opencode/big-pickle'${tail}`,
    env: { [OPENCODE_STARTUP_PROMPT_BODY_ENV]: prompt },
    envToDelete: [],
    cwd: '/repo/powershell',
    isFreshLaunch: true,
    shell: 'powershell'
  })
  expect(result.command).toBe(`opencode --standalone${tail}`)
})
