import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService, type AgentTeamsTerminalApi } from './claude-agent-teams-service'

function createServiceWithLeader(): {
  service: ClaudeAgentTeamsService
  teamId: string
  token: string
  leaderPane: string
  api: AgentTeamsTerminalApi
  splitCalls: {
    handle: string
    direction?: string
    command?: string
    cwd?: string
    envPane?: string
    envClaudecode?: string
  }[]
} {
  const service = new ClaudeAgentTeamsService()
  const launch = service.createLaunchEnv({
    leaderHandle: 'leader-handle',
    baseEnv: { PATH: '/usr/bin' },
    shimDir: '/tmp/orca-shim',
    shimBin: '/usr/bin/orca'
  })
  expect(launch.env.ORCA_AGENT_TEAMS_SHIM_DIR).toBe('/tmp/orca-shim')
  const splitCalls: {
    handle: string
    direction?: string
    command?: string
    cwd?: string
    envPane?: string
    envClaudecode?: string
  }[] = []
  let splitCount = 0
  const api: AgentTeamsTerminalApi = {
    splitTerminal: vi.fn(async (handle, opts) => {
      splitCount += 1
      splitCalls.push({
        handle,
        direction: opts.direction,
        command: opts.command,
        cwd: opts.cwd,
        envPane: opts.env?.TMUX_PANE,
        envClaudecode: opts.env?.CLAUDECODE
      })
      return { handle: `teammate-${splitCount}`, tabId: 'tab-1', paneRuntimeId: -1 }
    }),
    readTerminal: vi.fn(async (handle) => ({
      handle,
      status: 'running' as const,
      tail: ['line one', 'line two'],
      truncated: false,
      nextCursor: null
    })),
    sendTerminal: vi.fn(async (handle, action) => ({
      handle,
      accepted: Boolean(action.text),
      bytesWritten: action.text?.length ?? 0
    })),
    focusTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', worktreeId: 'wt-1' })),
    closeTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', ptyKilled: true })),
    showTerminal: vi.fn(async (handle) => ({
      handle,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt',
      branch: 'main',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      title: null,
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: -1,
      ptyId: 'pty-1',
      rendererGraphEpoch: 1
    }))
  }
  return {
    service,
    teamId: launch.teamId,
    token: launch.token,
    leaderPane: launch.leaderPane,
    api,
    splitCalls
  }
}

describe('ClaudeAgentTeamsService', () => {
  it('supports Claude core tmux teammate sequence with native splits', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await expect(
      request(['display-message', '-t', leaderPane, '-p', '#{session_name}:#{window_index}'])
    ).resolves.toMatchObject({ stdout: 'orca:0\n', exitCode: 0 })

    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%2\n', exitCode: 0 })

    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['resize-pane', '-t', leaderPane, '-x', '30%'])

    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({
      stdout: '%1\n%2\n'
    })
    expect(splitCalls).toEqual([
      { handle: 'leader-handle', direction: 'vertical', command: undefined, envPane: '%2' }
    ])
  })

  it('puts the first teammate on the right, then stacks repeated main-vertical teammates downward', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])
    await request(['split-window', '-t', leaderPane, '-h', '-l', '70%', '-P', '-F', '#{pane_id}'])

    expect(splitCalls.map((call) => [call.handle, call.direction, call.envPane])).toEqual([
      ['leader-handle', 'vertical', '%2'],
      ['teammate-1', 'horizontal', '%3'],
      ['teammate-2', 'horizontal', '%4']
    ])
  })

  it('does not recycle fake pane ids after a teammate closes', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    await request(['kill-pane', '-t', '%3'])

    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%4\n', exitCode: 0 })
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({
      stdout: '%1\n%2\n%4\n'
    })
    expect(splitCalls.map((call) => [call.handle, call.direction, call.envPane])).toEqual([
      ['leader-handle', 'vertical', '%2'],
      ['teammate-1', 'horizontal', '%3'],
      ['teammate-1', 'horizontal', '%4']
    ])
  })

  it('relaunches a teammate via respawn-pane after a cat holding split', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    // Claude splits a holding pane running `cat`, then respawns it with the
    // real teammate command (the failure mode before respawn-pane was supported).
    await expect(
      request([
        'split-window',
        '-d',
        '-t',
        leaderPane,
        '-h',
        '-l',
        '70%',
        '-P',
        '-F',
        '#{pane_id}',
        '--',
        'cat'
      ])
    ).resolves.toMatchObject({ stdout: '%2\n', exitCode: 0 })

    await request(['set-option', '-p', '-t', '%2', 'remain-on-exit', 'failed'])

    const teammateCommand = 'cd /repo && env CLAUDECODE=1 claude --agent-id a --teammate-mode auto'
    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', teammateCommand])
    ).resolves.toMatchObject({ stdout: '', exitCode: 0 })

    // the placeholder terminal is closed and the pane is recreated, from the same
    // origin/direction, with the real teammate command.
    //
    // Why: the POSIX `cd … && env … <cmd>` string is decomposed into Orca's own spawn
    // options rather than executed as shell syntax, so the pane's shell never has to
    // understand `&&` or `env` — PowerShell does not.
    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
    expect(splitCalls).toEqual([
      {
        handle: 'leader-handle',
        direction: 'vertical',
        // Why: the `cat` holding command is dropped on Windows only, so derive the
        // expectation rather than hard-coding one platform's answer.
        command: process.platform === 'win32' ? undefined : 'cat',
        cwd: undefined,
        envPane: '%2',
        envClaudecode: undefined
      },
      {
        handle: 'leader-handle',
        direction: 'vertical',
        command: 'claude --agent-id a --teammate-mode auto',
        cwd: '/repo',
        envPane: '%2',
        envClaudecode: '1'
      }
    ])

    // the fake pane id is preserved and now backed by the relaunched terminal.
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n%2\n' })

    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenLastCalledWith('teammate-2')
  })

  it('keeps the placeholder handle when the respawn split fails', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request([
      'split-window',
      '-d',
      '-t',
      leaderPane,
      '-h',
      '-P',
      '-F',
      '#{pane_id}',
      '--',
      'cat'
    ])

    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('no space for new pane'))
    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })

    // the placeholder terminal is left intact and the fake pane id still resolves.
    expect(api.closeTerminal).not.toHaveBeenCalled()
    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
  })

  it('refuses to respawn the leader pane', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()

    await expect(
      service.handleTmuxCompat(
        {
          teamId,
          token,
          envPane: leaderPane,
          argv: ['respawn-pane', '-k', '-t', leaderPane, '--', 'cat']
        },
        api
      )
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      stderr: 'tmux: refusing to respawn leader pane\n'
    })
  })

  it('rejects stale or unauthorized shim calls', async () => {
    const { service, teamId, leaderPane, api } = createServiceWithLeader()

    await expect(
      service.handleTmuxCompat(
        { teamId, token: 'wrong', envPane: leaderPane, argv: ['list-panes'] },
        api
      )
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
  })

  it('keeps the inherited PATH when the caller sends Windows-cased Path', () => {
    // Why: native Windows processes expose `Path`, so reading baseEnv.PATH dropped the
    // inherited PATH and left the teammate with only the shim dir — `claude` then
    // failed to spawn with ENOENT.
    const service = new ClaudeAgentTeamsService()
    const launch = service.createLaunchEnv({
      leaderHandle: 'leader-handle',
      baseEnv: { Path: 'C:\\Windows\\System32' },
      shimDir: 'C:\\shim',
      shimBin: 'C:\\orca.exe'
    })

    // Written back under the caller's own key so the child cannot end up with both.
    expect(launch.env.Path).toContain('C:\\Windows\\System32')
    expect(launch.env.Path).toContain('C:\\shim')
    expect(launch.env.PATH).toBeUndefined()
  })

  it('still uses PATH when the caller sends POSIX-cased PATH', () => {
    const service = new ClaudeAgentTeamsService()
    const launch = service.createLaunchEnv({
      leaderHandle: 'leader-handle',
      baseEnv: { PATH: '/usr/bin' },
      shimDir: '/tmp/orca-shim',
      shimBin: '/usr/bin/orca'
    })

    expect(launch.env.PATH).toContain('/usr/bin')
    expect(launch.env.PATH).toContain('/tmp/orca-shim')
    expect(launch.env.Path).toBeUndefined()
  })
})
