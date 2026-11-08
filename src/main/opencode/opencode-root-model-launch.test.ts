import { beforeEach, expect, it, vi } from 'vitest'
import { prepareOpenCodePtyLaunch } from './opencode-pty-launch'

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

it('starts OpenCode 2 on its own server with the picked model in its launch config', async () => {
  const result = await launch('2.0.21', "opencode '--model' 'opencode/big-pickle'")
  expect(result.command).toBe('opencode --standalone')
  expect(JSON.parse(result.env?.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
    autoupdate: false,
    model: 'opencode/big-pickle',
    agents: { build: { model: 'opencode/big-pickle' } }
  })
})

it('keeps the overlay when the caller asked to drop inherited OpenCode config', async () => {
  const result = await launch('2.0.21', 'opencode --model opencode/big-pickle', [
    'OPENCODE_CONFIG_CONTENT'
  ])
  expect(JSON.parse(result.env?.OPENCODE_CONFIG_CONTENT ?? '')).toMatchObject({
    model: 'opencode/big-pickle'
  })
  expect(result.envToDelete).not.toContain('OPENCODE_CONFIG_CONTENT')
})
