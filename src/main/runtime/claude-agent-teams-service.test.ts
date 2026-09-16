import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService, type AgentTeamsTerminalApi } from './claude-agent-teams-service'

function createServiceWithLeader(options?: {
  leaderPaneKey?: string
  resolveTerminalHandleForPaneKey?: (paneKey: string) => string | null
}): {
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
    leaderPaneKey: options?.leaderPaneKey,
    baseEnv: { PATH: '/usr/bin' },
    shimDir: '/tmp/orca-shim',
    shimBin: '/usr/bin/orca'
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
    })),
    ...(options?.resolveTerminalHandleForPaneKey
      ? { resolveTerminalHandleForPaneKey: vi.fn(options.resolveTerminalHandleForPaneKey) }
      : {})
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

  it('remints a stale leader handle via its pane key and retries the split', async () => {
    const { service, teamId, token, leaderPane, api, splitCalls } = createServiceWithLeader({
      leaderPaneKey: 'tab-1:leaf-leader',
      resolveTerminalHandleForPaneKey: () => 'leader-handle-2'
    })
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('terminal_handle_stale'))
    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%2\n', exitCode: 0 })
    expect(api.resolveTerminalHandleForPaneKey).toHaveBeenCalledWith('tab-1:leaf-leader')
    expect(splitCalls.map((call) => call.handle)).toEqual(['leader-handle-2'])

    // the reminted handle is persisted — later leader operations use it directly.
    await request(['send-keys', '-t', leaderPane, '-l', 'hello'])
    expect(vi.mocked(api.sendTerminal).mock.calls.map(([handle]) => handle)).toEqual([
      'leader-handle-2'
    ])
    expect(vi.mocked(api.resolveTerminalHandleForPaneKey!).mock.calls).toHaveLength(1)
  })

  it('propagates stale errors when the pane has no pane key to remint from', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader()
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('terminal_handle_stale'))
    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      stderr: 'tmux: terminal_handle_stale\n'
    })
  })

  it('retries once with the same handle when resolving healed epoch-only staleness', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader({
      leaderPaneKey: 'tab-1:leaf-leader',
      resolveTerminalHandleForPaneKey: () => 'leader-handle'
    })
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    // resolving by pane key re-registers the same handle against the current
    // epoch, so the retry with the identical string succeeds.
    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('terminal_handle_stale'))
    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ stdout: '%2\n', exitCode: 0 })
    expect(vi.mocked(api.splitTerminal).mock.calls.map(([handle]) => handle)).toEqual([
      'leader-handle',
      'leader-handle'
    ])
  })

  it('propagates the stale error when the retry fails too', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader({
      leaderPaneKey: 'tab-1:leaf-leader',
      resolveTerminalHandleForPaneKey: () => 'leader-handle'
    })
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    vi.mocked(api.splitTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.splitTerminal).toHaveBeenCalledTimes(2)
  })

  it('does not retry when the resolver returns no handle', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader({
      leaderPaneKey: 'tab-1:leaf-leader',
      resolveTerminalHandleForPaneKey: () => null
    })
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('terminal_handle_stale'))
    await expect(
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ).resolves.toMatchObject({ ok: false, exitCode: 1 })
    expect(api.splitTerminal).toHaveBeenCalledTimes(1)
  })

  it('remints for both callers when concurrent operations race on the same stale handle', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader({
      leaderPaneKey: 'tab-1:leaf-leader',
      resolveTerminalHandleForPaneKey: () => 'leader-handle-2'
    })
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    let teammateCount = 0
    vi.mocked(api.splitTerminal).mockImplementation(async (handle) => {
      if (handle === 'leader-handle') {
        throw new Error('terminal_handle_stale')
      }
      teammateCount += 1
      return { handle: `teammate-${teammateCount}`, tabId: 'tab-1', paneRuntimeId: -1 }
    })

    // Both calls attempt the same stale handle; the race loser must still retry
    // instead of matching the winner's freshly persisted handle and giving up.
    const [first, second] = await Promise.all([
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}']),
      request(['split-window', '-t', leaderPane, '-h', '-P', '-F', '#{pane_id}'])
    ])
    expect(first).toMatchObject({ exitCode: 0 })
    expect(second).toMatchObject({ exitCode: 0 })
    expect(
      vi
        .mocked(api.splitTerminal)
        .mock.calls.map(([handle]) => handle)
        .sort()
    ).toEqual(['leader-handle', 'leader-handle', 'leader-handle-2', 'leader-handle-2'])
  })

  it('remints a stale leader handle for send-keys as well', async () => {
    const { service, teamId, token, leaderPane, api } = createServiceWithLeader({
      leaderPaneKey: 'tab-1:leaf-leader',
      resolveTerminalHandleForPaneKey: () => 'leader-handle-2'
    })
    const request = (argv: string[]) =>
      service.handleTmuxCompat({ teamId, token, envPane: leaderPane, argv }, api)

    vi.mocked(api.sendTerminal).mockRejectedValueOnce(new Error('terminal_handle_stale'))
    await expect(request(['send-keys', '-t', leaderPane, '-l', 'hello'])).resolves.toMatchObject({
      exitCode: 0
    })
    expect(vi.mocked(api.sendTerminal).mock.calls.map(([handle]) => handle)).toEqual([
      'leader-handle',
      'leader-handle-2'
    ])
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
