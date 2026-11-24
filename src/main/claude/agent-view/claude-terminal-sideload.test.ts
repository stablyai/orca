import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  prewarmClaudeTerminalSideload,
  prepareClaudeTerminalSideload
} from './claude-terminal-sideload'
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
  const run = vi.fn(async (_options: unknown) => ({
    code: 1,
    stdout: '',
    stderr,
    timedOut: false,
    signal: null,
    environmentResolved: true
  }))
  const deps = {
    support,
    resolveCommandOnLocalPath: async () => '/bin/claude',
    runProcess: run,
    runWslProcess: run
  }
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
  it('remembers background refusal for the next terminal and native chat across folders', async () => {
    const { deps, support, run } = fixture()
    const launch = input()
    await prewarmClaudeTerminalSideload(launch, deps)
    prepareClaudeTerminalSideload(launch, support)
    expect(launch.env).toEqual({
      CLAUDE_CONFIG_DIR: '/account/locked',
      CLAUDE_CODE_PLUGIN_DIRS: ''
    })
    expect(
      await support.check(CLAUDE_PLUGIN_DIR_FLAG, {
        command: '/bin/claude',
        cwd: '/another-project',
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
    await prewarmClaudeTerminalSideload(other, deps)
    prepareClaudeTerminalSideload(other, support)
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
    await prewarmClaudeTerminalSideload(launch, deps)
    prepareClaudeTerminalSideload(launch, support)
    expect(launch.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('/user/plugin')
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves unrelated failures unknown and isolates guest refusal memory from native launches', async () => {
    const { deps, support } = fixture('unrelated startup failure')
    const launch = input()
    await prewarmClaudeTerminalSideload(launch, deps)
    prepareClaudeTerminalSideload(launch, support)
    expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBe('/orca/plugin')
    deps.runWslProcess.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: refusal,
      timedOut: false,
      signal: null,
      environmentResolved: true
    })
    await prewarmClaudeTerminalSideload({ ...launch, wsl: { distro: 'work' } }, deps)
    prepareClaudeTerminalSideload({ ...launch, wsl: { distro: 'work' } }, support)
    expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
    expect(deps.runWslProcess.mock.calls[1][0]).toMatchObject({
      distro: 'work',
      program: 'claude',
      input: ''
    })
  })
})

it('checks the sequenced child under the login-shell config folder', async () => {
  const { deps, support, run } = fixture()
  const launch = {
    command: `bash -lc 'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"'`,
    cwd: '/project',
    shell: 'posix' as const,
    env: {
      ORCA_SEQUENCED_STARTUP_COMMAND: 'claude --resume session',
      ORCA_CLAUDE_CONFIG_DIR: '/account/login-shell',
      ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: '/orca/plugin',
      CLAUDE_CODE_PLUGIN_DIRS: '/orca/plugin'
    }
  }
  await prewarmClaudeTerminalSideload(launch, deps)
  prepareClaudeTerminalSideload(launch, support)
  expect(run.mock.calls[0][0]).toMatchObject({ env: { CLAUDE_CONFIG_DIR: '/account/login-shell' } })
  expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
})

it('suppresses remembered plugin injection for wrapped and compound commands', () => {
  const { support } = fixture()
  support.observeExit(
    { command: '/bin/claude', cwd: '/project', env: input().env },
    new Error(refusal)
  )
  for (const command of ['env claude --resume session', 'echo ready; claude']) {
    const launch = { ...input(), command }
    prepareClaudeTerminalSideload(launch, support)
    expect(launch.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
    expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
  }
})

it('can prepare an account after execution was skipped because the CLI was unavailable', async () => {
  const { deps, support } = fixture()
  let command: string | null = null
  const probe = { ...deps, resolveCommandOnLocalPath: async () => command }
  await prewarmClaudeTerminalSideload(input(), probe)
  command = '/bin/claude'
  const launch = input()
  await prewarmClaudeTerminalSideload(launch, probe)
  prepareClaudeTerminalSideload(launch, support)
  expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
})

it('keys inherited WSL config passthrough after path translation', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', String.raw`C:\accounts\locked`)
  vi.stubEnv('WSLENV', 'CLAUDE_CONFIG_DIR/p')
  try {
    const { deps, support, run } = fixture()
    const launch = {
      command: 'claude',
      cwd: '/project',
      shell: 'posix' as const,
      wsl: { distro: 'work' },
      env: {
        ORCA_CLAUDE_CONFIG_DIR: '/home/guest/.claude',
        ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: '/orca/plugin'
      }
    }
    await prewarmClaudeTerminalSideload(launch, deps)
    expect(run.mock.calls[0][0]).toMatchObject({
      env: { CLAUDE_CONFIG_DIR: String.raw`C:\accounts\locked`, WSLENV: 'CLAUDE_CONFIG_DIR/p' }
    })
    const translated = {
      ...launch,
      env: {
        ...launch.env,
        CLAUDE_CONFIG_DIR: '/mnt/c/accounts/locked',
        WSLENV: 'CLAUDE_CONFIG_DIR'
      }
    }
    prepareClaudeTerminalSideload(translated, support)
    expect(translated.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
  } finally {
    vi.unstubAllEnvs()
  }
})

it('uses literal account prefixes even when the command cannot accept flag insertion', () => {
  const { support } = fixture()
  support.observeExit(
    { command: '/bin/claude', cwd: '/project', env: input().env },
    new Error(refusal)
  )
  for (const command of [
    'CLAUDE_CONFIG_DIR=/account/locked claude; echo done',
    'env CLAUDE_CONFIG_DIR=/account/locked claude'
  ]) {
    const launch = { ...input('/account/open'), command }
    prepareClaudeTerminalSideload(launch, support)
    expect(launch.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
  }
})

it('keeps a Windows-only config passthrough out of the guest account check', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', String.raw`C:\accounts\personal`)
  vi.stubEnv('WSLENV', 'CLAUDE_CONFIG_DIR/w')
  try {
    const { deps, support, run } = fixture()
    const launch = {
      command: 'claude',
      cwd: '/project',
      shell: 'posix' as const,
      wsl: { distro: 'work' },
      env: {
        ORCA_CLAUDE_CONFIG_DIR: '/home/guest/.claude',
        ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: '/orca/plugin'
      }
    }
    await prewarmClaudeTerminalSideload(launch, deps)
    expect(run.mock.calls[0][0]).toMatchObject({ env: { WSLENV: 'CLAUDE_CONFIG_DIR/w' } })
    expect(run.mock.calls[0][0]).not.toMatchObject({
      env: { CLAUDE_CONFIG_DIR: String.raw`C:\accounts\personal` }
    })
    prepareClaudeTerminalSideload(launch, support)
    expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each(['w', 'p'])(
  'forwards a literal guest account without inherited /%s transport rules',
  async (direction) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', String.raw`C:\accounts\personal`)
    vi.stubEnv('WSLENV', `CLAUDE_CONFIG_DIR/${direction}:OTHER/p`)
    try {
      const { deps, support, run } = fixture()
      const launch = {
        command: 'CLAUDE_CONFIG_DIR=/account/locked claude',
        cwd: '/project',
        shell: 'posix' as const,
        wsl: { distro: 'work' },
        env: {
          ORCA_CLAUDE_CONFIG_DIR: '/home/guest/.claude',
          ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR: '/orca/plugin'
        }
      }
      await prewarmClaudeTerminalSideload(launch, deps)
      expect(run.mock.calls[0][0]).toMatchObject({
        env: { CLAUDE_CONFIG_DIR: '/account/locked', WSLENV: 'OTHER/p' }
      })
      prepareClaudeTerminalSideload(launch, support)
      expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  }
)

it('keeps relative config folders isolated by their execution directory', async () => {
  const { deps, support } = fixture(noInput)
  const open = { ...input('.claude'), cwd: '/project/open' }
  await prewarmClaudeTerminalSideload(open, deps)
  deps.runProcess.mockResolvedValueOnce({
    code: 1,
    stdout: '',
    stderr: refusal,
    timedOut: false,
    signal: null,
    environmentResolved: true
  })
  const locked = { ...input('.claude'), cwd: '/project/locked' }
  await prewarmClaudeTerminalSideload(locked, deps)
  prepareClaudeTerminalSideload(locked, support)
  prepareClaudeTerminalSideload(open, support)
  expect(locked.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
  expect(open.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBe('/orca/plugin')
})

it('does not attribute an earlier command account to Claude', () => {
  const { support } = fixture()
  support.observeExit(
    { command: '/bin/claude', cwd: '/project', env: input().env },
    new Error(refusal)
  )
  const launch = { ...input(), command: 'CLAUDE_CONFIG_DIR=/account/open make; claude' }
  prepareClaudeTerminalSideload(launch, support)
  expect(launch.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
})

it('retries preparation after an execution error without caching an inconclusive fact', async () => {
  const { deps, support, run } = fixture()
  run.mockRejectedValueOnce(new Error('binary temporarily unavailable'))
  await prewarmClaudeTerminalSideload(input(), deps)
  const launch = input()
  await prewarmClaudeTerminalSideload(launch, deps)
  prepareClaudeTerminalSideload(launch, support)
  expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
})

it('recognizes an unquoted compact redirect without treating a quoted executable as a shell operator', () => {
  const { support } = fixture()
  support.observeExit(
    { command: '/bin/claude', cwd: '/project', env: input().env },
    new Error(refusal)
  )
  const launch = {
    ...input('/account/open'),
    command: 'CLAUDE_CONFIG_DIR=/account/locked claude>log'
  }
  prepareClaudeTerminalSideload(launch, support)
  expect(launch.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
  const quoted = {
    ...input('/account/open'),
    command: "CLAUDE_CONFIG_DIR=/account/locked '/tools/claude>other/bin'"
  }
  prepareClaudeTerminalSideload(quoted, support)
  expect(quoted.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBe('/orca/plugin')
})

it.each(['~/.locked', '$HOME/.locked'])(
  'does not execute or borrow another account fact for unresolved shell path %s',
  async (account) => {
    const { deps, support, run } = fixture()
    support.observeExit(
      { command: '/bin/claude', cwd: '/project', env: input().env },
      new Error(refusal)
    )
    const launch = { ...input(), command: `CLAUDE_CONFIG_DIR=${account} claude` }
    await prewarmClaudeTerminalSideload(launch, deps)
    prepareClaudeTerminalSideload(launch, support)
    expect(run).not.toHaveBeenCalled()
    expect(launch.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBe('/orca/plugin')
  }
)
