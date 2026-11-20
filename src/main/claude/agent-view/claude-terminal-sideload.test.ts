import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareClaudeTerminalSideload } from './claude-terminal-sideload'
import {
  CLAUDE_PLUGIN_DIR_FLAG,
  createClaudeCliFlagSupport
} from '../cli-capabilities/claude-cli-flag-support'

const refusal =
  "Error: --plugin-dir, CLAUDE_CODE_PLUGIN_DIRS are disabled by your organization's managed settings (disableSideloadFlags)."
const noInput =
  'Error: Input must be provided either through stdin or as a prompt argument when using --print'

function fixture(stderr = refusal) {
  const support = createClaudeCliFlagSupport({
    probe: async () => '2.1.325',
    keyOf: async (command, cwd) => `${command}:${cwd}`,
    budgetMs: 1000,
    now: () => performance.now()
  })
  const resolveLaunch = async (input: { env: Record<string, string> }) => ({
    command: '/bin/claude',
    cwd: '/project',
    env: input.env
  })
  const run = vi.fn(async (_options: unknown) => ({
    code: 1,
    stdout: '',
    stderr,
    timedOut: false,
    signal: null,
    environmentResolved: true
  }))
  const deps = { support, resolveLaunch, runProcess: run, runWslProcess: run }
  return { support, deps, run }
}

function input(account = '/account/locked') {
  return {
    command: 'claude --resume session',
    cwd: '/project',
    shell: 'posix' as const,
    env: {
      CLAUDE_CONFIG_DIR: account,
      CLAUDE_CODE_PLUGIN_DIRS: '/orca/plugin',
      ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: '/orca/plugin',
      ORCA_CLAUDE_CONFIG_DIR: account
    }
  }
}

describe('terminal Claude under managed sideload policy', () => {
  it('drops both Orca carriers before the first terminal command and shares refusal with chat', async () => {
    const { deps, support, run } = fixture()
    const launch = input()
    await prepareClaudeTerminalSideload(launch, deps)
    expect(launch.env).toEqual({
      CLAUDE_CONFIG_DIR: '/account/locked',
      CLAUDE_CODE_PLUGIN_DIRS: ''
    })
    expect(
      await support.check(CLAUDE_PLUGIN_DIR_FLAG, {
        command: '/bin/claude',
        cwd: '/project',
        env: { CLAUDE_CONFIG_DIR: '/account/locked' }
      })
    ).toBe('unsupported')
    expect(run.mock.calls[0][0]).toMatchObject({
      input: '',
      args: [
        '--plugin-dir',
        '/orca/plugin',
        '--print',
        '--strict-mcp-config',
        '--settings',
        '{"disableAllHooks":true}'
      ]
    })

    const other = input('/account/open')
    deps.runProcess.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: noInput,
      timedOut: false,
      signal: null,
      environmentResolved: true
    })
    await prepareClaudeTerminalSideload(other, deps)
    expect(other.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBe('/orca/plugin')
  })

  it('honors a native-chat refusal without executing another policy probe and preserves user folders', async () => {
    const { deps, support, run } = fixture()
    support.observeExit(
      { command: '/bin/claude', cwd: '/project', env: input().env },
      new Error(refusal)
    )
    const launch = input()
    launch.env.CLAUDE_CODE_PLUGIN_DIRS = ['/user/plugin', '/orca/plugin'].join(delimiter)
    await prepareClaudeTerminalSideload(launch, deps)
    expect(launch.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('/user/plugin')
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves unknown failures retryable and passes guest launches through the WSL runner', async () => {
    const { deps } = fixture('unrelated startup failure')
    const launch = input()
    await prepareClaudeTerminalSideload(launch, deps)
    expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBe('/orca/plugin')
    deps.runWslProcess.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: refusal,
      timedOut: false,
      signal: null,
      environmentResolved: true
    })
    await prepareClaudeTerminalSideload({ ...launch, wsl: { distro: 'work' } }, deps)
    expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
    expect(deps.runWslProcess.mock.calls[1][0]).toMatchObject({
      distro: 'work',
      program: '/bin/claude',
      input: ''
    })
  })
})
