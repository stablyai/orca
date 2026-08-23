import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService, type AgentTeamsTerminalApi } from './claude-agent-teams-service'

function createServiceWithLeader(paneShell: 'posix' | 'powershell' = 'posix'): {
  service: ClaudeAgentTeamsService
  teamId: string
  token: string
  leaderPane: string
  api: AgentTeamsTerminalApi
  splitCalls: { handle: string; direction?: string; command?: string; envPane?: string }[]
} {
  const service = new ClaudeAgentTeamsService()
  const launch = service.createLaunchEnv({
    leaderHandle: 'leader-handle',
    baseEnv: { PATH: '/usr/bin' },
    shimDir: '/tmp/orca-shim',
    shimBin: '/usr/bin/orca',
    paneShell
  })
  expect(launch.env.ORCA_AGENT_TEAMS_SHIM_DIR).toBe('/tmp/orca-shim')
  const splitCalls: { handle: string; direction?: string; command?: string; envPane?: string }[] =
    []
  let splitCount = 0
  const api: AgentTeamsTerminalApi = {
    splitTerminal: vi.fn(async (handle, opts) => {
      splitCount += 1
      splitCalls.push({
        handle,
        direction: opts.direction,
        command: opts.command,
        envPane: opts.env?.TMUX_PANE
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
    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
    expect(splitCalls).toEqual([
      { handle: 'leader-handle', direction: 'vertical', command: 'cat', envPane: '%2' },
      { handle: 'leader-handle', direction: 'vertical', command: teammateCommand, envPane: '%2' }
    ])

    // the fake pane id is preserved and now backed by the relaunched terminal.
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n%2\n' })

    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenLastCalledWith('teammate-2')
  })

  it('uses a started ancestor when virtual holding panes respawn out of order', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } =
      createServiceWithLeader('powershell')
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', '--', 'cat'])
    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', '--', 'cat'])
    await expect(
      request(['respawn-pane', '-k', '-t', '%3', '--', 'claude --agent-id second'])
    ).resolves.toMatchObject({ ok: true })
    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id first'])
    ).resolves.toMatchObject({ ok: true })

    expect(splitCalls.map((call) => call.handle)).toEqual(['leader-handle', 'leader-handle'])
  })

  it('preserves the logical main-vertical parent while holding panes are virtual', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } =
      createServiceWithLeader('powershell')
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', '--', 'cat'])
    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', '--', 'cat'])
    await request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id first'])
    await request(['respawn-pane', '-k', '-t', '%3', '--', 'claude --agent-id second'])

    expect(splitCalls.map((call) => [call.handle, call.direction])).toEqual([
      ['leader-handle', 'vertical'],
      ['teammate-1', 'horizontal']
    ])
  })

  it('falls back to the leader when a virtual pane ancestor has exited', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } =
      createServiceWithLeader('powershell')
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await request([
      'split-window',
      '-t',
      leaderPane,
      '-h',
      '-P',
      '-F',
      '#{pane_id}',
      '--',
      'claude'
    ])
    await request(['select-layout', '-t', 'orca:0', 'main-vertical'])
    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', '--', 'cat'])
    service.onTerminalExited('teammate-1')

    await expect(
      request(['respawn-pane', '-k', '-t', '%3', '--', 'claude --agent-id replacement'])
    ).resolves.toMatchObject({ ok: true })
    expect(splitCalls.map((call) => call.handle)).toEqual(['leader-handle', 'leader-handle'])
  })

  it('delivers Claude teammate cwd and env through the native PowerShell split owner', async () => {
    const service = new ClaudeAgentTeamsService()
    const launch = service.createLaunchEnv({
      leaderHandle: 'leader-handle',
      baseEnv: { Path: 'C:\\Windows\\System32', CLAUDECODE: 'inherited' },
      shimDir: 'C:\\orca-shim',
      shimBin: 'C:\\orca.exe',
      shimEnv: {
        ORCA_AGENT_TEAMS_SHIM_EXECUTABLE: 'C:\\node.exe',
        ORCA_AGENT_TEAMS_SHIM_CLI_ENTRY: 'C:\\repo\\out\\cli\\index.js'
      },
      paneShell: 'powershell'
    })
    const splitTerminal = vi.fn(async () => ({
      handle: 'teammate-1',
      tabId: 'tab-1',
      paneRuntimeId: -1
    }))
    const api = { ...createServiceWithLeader().api, splitTerminal }
    const command =
      "cd 'E:\\repo' && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 " +
      "ANTHROPIC_BASE_URL=http://relay.example:31416 'C:\\tools\\claude.exe' " +
      '--agent-id WinProbe@session-1 --agent-name WinProbe --team-name session-1 ' +
      '--agent-color blue --parent-session-id parent-1 --agent-type general-purpose ' +
      "--dangerously-skip-permissions --model 'opus[1m]'"

    await service.handleTmuxCompat(
      {
        teamId: launch.teamId,
        token: launch.token,
        envPane: launch.leaderPane,
        argv: ['split-window', '-t', launch.leaderPane, '-P', '-F', '#{pane_id}', '--', 'cat']
      },
      api
    )
    await service.handleTmuxCompat(
      {
        teamId: launch.teamId,
        token: launch.token,
        envPane: launch.leaderPane,
        argv: ['-S', '/tmp/orca/team', 'respawn-pane', '-k', '-t', '%2', '--', command]
      },
      api
    )

    expect(splitTerminal).toHaveBeenCalledWith(
      'leader-handle',
      expect.objectContaining({
        command: undefined,
        cwd: 'E:\\repo',
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: 'http://relay.example:31416',
          CLAUDECODE: '1',
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          ORCA_AGENT_TEAMS_SHIM_CLI_ENTRY: 'C:\\repo\\out\\cli\\index.js',
          ORCA_AGENT_TEAMS_SHIM_EXECUTABLE: 'C:\\node.exe',
          TMUX_PANE: '%2'
        }),
        agentTeamsProcess: {
          argv: [
            'C:\\tools\\claude.exe',
            '--agent-id',
            'WinProbe@session-1',
            '--agent-name',
            'WinProbe',
            '--team-name',
            'session-1',
            '--agent-color',
            'blue',
            '--parent-session-id',
            'parent-1',
            '--agent-type',
            'general-purpose',
            '--dangerously-skip-permissions',
            '--model',
            'opus[1m]'
          ],
          holding: false
        }
      })
    )
    expect(splitTerminal).toHaveBeenCalledTimes(1)
    expect(api.closeTerminal).not.toHaveBeenCalled()
  })

  it('validates a respawn before closing its holding pane', async () => {
    const service = new ClaudeAgentTeamsService()
    const launch = service.createLaunchEnv({
      leaderHandle: 'leader-handle',
      baseEnv: { Path: 'C:\\Windows\\System32' },
      shimDir: 'C:\\orca-shim',
      shimBin: 'C:\\orca.exe',
      paneShell: 'powershell'
    })
    const { api } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat(
        { teamId: launch.teamId, token: launch.token, envPane: launch.leaderPane, argv },
        api
      )

    await request(['split-window', '-t', launch.leaderPane, '-P', '-F', '#{pane_id}', '--', 'cat'])
    vi.mocked(api.closeTerminal).mockClear()
    vi.mocked(api.splitTerminal).mockClear()

    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude | tee log'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.closeTerminal).not.toHaveBeenCalled()
    expect(api.splitTerminal).not.toHaveBeenCalled()
    await expect(request(['list-panes', '-F', '#{pane_id}'])).resolves.toMatchObject({
      stdout: '%1\n%2\n'
    })
  })

  it('fences an in-flight respawn when its leader is removed', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)
    await request(['split-window', '-t', leaderPane, '-P', '-F', '#{pane_id}', '--', 'cat'])
    let releaseClose!: () => void
    vi.mocked(api.closeTerminal).mockImplementationOnce(
      (handle) =>
        new Promise((resolve) => {
          releaseClose = () => resolve({ handle, tabId: 'tab-1', ptyKilled: true })
        })
    )
    vi.mocked(api.splitTerminal).mockClear()

    const respawn = request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    await vi.waitFor(() => expect(api.closeTerminal).toHaveBeenCalledOnce())
    service.removeTeamForLeaderHandle('leader-handle')
    releaseClose()

    await expect(respawn).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.splitTerminal).not.toHaveBeenCalled()
    expect(service.getActiveTeamCount()).toBe(0)
  })

  it('retires a split that finishes after its leader is removed', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    let releaseSplit!: () => void
    vi.mocked(api.splitTerminal).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSplit = () => resolve({ handle: 'late-pane', tabId: 'tab-1', paneRuntimeId: -1 })
        })
    )
    const split = service.handleTmuxCompat(
      {
        teamId,
        token,
        envPane: leaderPane,
        argv: ['split-window', '-t', leaderPane, '--', 'cat']
      },
      api
    )
    await vi.waitFor(() => expect(api.splitTerminal).toHaveBeenCalledOnce())
    service.removeTeamForLeaderHandle('leader-handle')
    releaseSplit()

    await expect(split).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.closeTerminal).toHaveBeenCalledWith('late-pane')
    expect(service.getActiveTeamCount()).toBe(0)
  })

  it('leaves unconfirmed late-split liveness with the terminal owner', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    let releaseSplit!: () => void
    vi.mocked(api.splitTerminal).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSplit = () => resolve({ handle: 'late-live', tabId: 'tab-1', paneRuntimeId: -1 })
        })
    )
    vi.mocked(api.closeTerminal).mockResolvedValueOnce({
      handle: 'late-live',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable'
    })
    const split = service.handleTmuxCompat(
      {
        teamId,
        token,
        envPane: leaderPane,
        argv: ['split-window', '-t', leaderPane, '--', 'claude --agent-id late']
      },
      api
    )
    await vi.waitFor(() => expect(api.splitTerminal).toHaveBeenCalledOnce())
    service.removeTeamForLeaderHandle('leader-handle')
    releaseSplit()

    await expect(split).resolves.toMatchObject({ ok: false, exitCode: 1 })
    service.onTerminalExited('late-live')
    expect(service.getActiveTeamCount()).toBe(0)
  })

  it('removes a teammate pane after its authoritative terminal exit', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request([
      'split-window',
      '-t',
      leaderPane,
      '-h',
      '-P',
      '-F',
      '#{pane_id}',
      '--',
      'claude --agent-id child'
    ])
    service.onTerminalExited('teammate-1')

    await expect(request(['list-panes', '-F', '#{pane_id}'])).resolves.toMatchObject({
      stdout: '%1\n'
    })
  })

  it('does not publish a teammate that exits before split registration', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    vi.mocked(api.splitTerminal).mockImplementationOnce(async () => {
      service.onTerminalExited('fast-exit')
      return { handle: 'fast-exit', tabId: 'tab-1', paneRuntimeId: -1 }
    })
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await expect(
      request(['split-window', '-t', leaderPane, '-P', '-F', '#{pane_id}', '--', 'claude'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.closeTerminal).toHaveBeenCalledWith('fast-exit')
    await expect(request(['list-panes', '-F', '#{pane_id}'])).resolves.toMatchObject({
      stdout: '%1\n'
    })
  })

  it('admits teammate liveness synchronously at pane publication', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    let observedHandle = false
    vi.mocked(api.splitTerminal).mockImplementationOnce(async () => ({
      get handle() {
        if (!observedHandle) {
          observedHandle = true
          service.onTerminalExited('commit-exit')
        }
        return 'commit-exit'
      },
      tabId: 'tab-1',
      paneRuntimeId: -1
    }))
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    await expect(
      request(['split-window', '-t', leaderPane, '-P', '-F', '#{pane_id}', '--', 'claude'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.closeTerminal).toHaveBeenCalledWith('commit-exit')
    await expect(request(['list-panes', '-F', '#{pane_id}'])).resolves.toMatchObject({
      stdout: '%1\n'
    })
  })

  it('keeps a replacement registered when the old pane exits during respawn', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)
    await request(['split-window', '-t', leaderPane, '-P', '-F', '#{pane_id}', '--', 'cat'])
    vi.mocked(api.closeTerminal).mockImplementationOnce(async (handle) => {
      service.onTerminalExited(handle)
      return { handle, tabId: 'tab-1', ptyKilled: true }
    })

    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id replacement'])
    ).resolves.toMatchObject({ ok: true })
    await expect(request(['list-panes', '-F', '#{pane_id}'])).resolves.toMatchObject({
      stdout: '%1\n%2\n'
    })
    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenLastCalledWith('teammate-2')
  })

  it('removes the pane when replacement split fails after a confirmed placeholder stop', async () => {
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

    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n' })
  })

  it('keeps a pane registered when its process stop is unconfirmed', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    vi.mocked(api.closeTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      tabId: 'tab-1',
      ptyKilled: false
    })

    await expect(request(['kill-pane', '-t', '%2'])).resolves.toMatchObject({
      ok: false,
      exitCode: 1
    })
    await expect(
      request(['list-panes', '-t', 'orca:0', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%1\n%2\n' })
  })

  it('does not launch a replacement when the placeholder stop is unconfirmed', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader()
    const request = (argv: string[], envPane = leaderPane) =>
      service.handleTmuxCompat({ teamId, token, envPane, argv }, api)

    await request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}', 'cat'])
    vi.mocked(api.closeTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'live'
    })

    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.closeTerminal).toHaveBeenNthCalledWith(1, 'teammate-1')
    expect(splitCalls).toHaveLength(1)

    await expect(
      request(['respawn-pane', '-k', '-t', '%2', '--', 'claude --agent-id a'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(splitCalls).toHaveLength(1)

    await request(['kill-pane', '-t', '%2'])
    expect(api.closeTerminal).toHaveBeenLastCalledWith('teammate-1')
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

  it('keeps the inherited Windows `Path` instead of minting a truncated `PATH`', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const launch = new ClaudeAgentTeamsService().createLaunchEnv({
        leaderHandle: 'leader-handle',
        baseEnv: { Path: 'C:\\Windows\\system32' },
        shimDir: 'C:\\orca-shim',
        shimBin: 'C:\\orca.exe'
      })

      expect(Object.keys(launch.env).filter((key) => /^path$/i.test(key))).toEqual(['Path'])
      expect(launch.env.Path).toBe('C:\\orca-shim;C:\\Windows\\system32')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
