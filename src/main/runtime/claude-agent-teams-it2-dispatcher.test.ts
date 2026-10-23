import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import type { AgentTeamsTerminalApi } from './claude-agent-teams-types'

function unused(): Promise<never> {
  return Promise.reject(new Error('unused in it2 tests'))
}

function createIt2Fixture() {
  const service = new ClaudeAgentTeamsService()
  const launch = service.createLaunchEnv({
    leaderHandle: 'leader-handle',
    baseEnv: { PATH: '/usr/bin' },
    shimDir: '/tmp/orca-shim',
    shimBin: '/usr/bin/orca',
    it2: { shimDir: '/tmp/orca-it2-shim', probeShell: '/tmp/orca-it2-shim/sh' }
  })
  let splitCount = 0
  const api: AgentTeamsTerminalApi = {
    splitTerminal: vi.fn(async () => {
      splitCount += 1
      return { handle: `teammate-${splitCount}`, tabId: 'tab-1', paneRuntimeId: -1 }
    }),
    sendTerminal: vi.fn(async (handle, action) => ({
      handle,
      accepted: Boolean(action.text),
      bytesWritten: action.text?.length ?? 0
    })),
    closeTerminal: vi.fn(async (handle) => ({ handle, tabId: 'tab-1', ptyKilled: true })),
    readTerminal: unused,
    focusTerminal: unused,
    showTerminal: unused
  }
  const it2 = (...argv: string[]) =>
    service.handleIt2Compat({ teamId: launch.teamId, token: launch.token, argv }, api)
  return { it2, api, launch }
}

describe('ClaudeAgentTeamsIt2Dispatcher', () => {
  it('drives Claude Code iTerm2 teammate lifecycle with native splits', async () => {
    const { it2, api } = createIt2Fixture()

    await expect(it2('session', 'list')).resolves.toMatchObject({
      stdout: 'orca-1-pane\n',
      exitCode: 0
    })

    await expect(it2('session', 'split', '-v', '-s', 'orca-1-pane')).resolves.toMatchObject({
      stdout: 'Created new pane: orca-2-pane\n',
      exitCode: 0
    })
    expect(api.splitTerminal).toHaveBeenLastCalledWith(
      'leader-handle',
      expect.objectContaining({
        direction: 'vertical',
        activate: false,
        envToDelete: ['TERM_PROGRAM'],
        env: expect.objectContaining({ TMUX_PANE: '%2', ORCA_AGENT_TEAMS_LEADER_PANE: '%1' })
      })
    )

    // Claude types the teammate command into the pane itself, so the split carries none.
    expect(vi.mocked(api.splitTerminal).mock.calls[0]?.[1]).not.toHaveProperty('command')

    await expect(it2('session', 'split', '-s', 'orca-2-pane')).resolves.toMatchObject({
      stdout: 'Created new pane: orca-3-pane\n'
    })
    expect(api.splitTerminal).toHaveBeenLastCalledWith(
      'teammate-1',
      expect.objectContaining({ direction: 'horizontal' })
    )

    await it2('session', 'send', '-s', 'orca-2-pane', '\x15')
    await expect(
      it2('session', 'run', '-s', 'orca-2-pane', 'cd /repo && claude --agent-id a')
    ).resolves.toMatchObject({ exitCode: 0 })
    expect(api.sendTerminal).toHaveBeenNthCalledWith(
      1,
      'teammate-1',
      { text: '\x15' },
      { inputKind: 'driving' }
    )
    expect(api.sendTerminal).toHaveBeenNthCalledWith(
      2,
      'teammate-1',
      { text: 'cd /repo && claude --agent-id a', enter: true },
      { inputKind: 'driving' }
    )

    await expect(it2('session', 'close', '-f', '-s', 'orca-2-pane')).resolves.toMatchObject({
      exitCode: 0
    })
    expect(api.closeTerminal).toHaveBeenCalledWith('teammate-1')
    await expect(it2('session', 'list')).resolves.toMatchObject({
      stdout: 'orca-1-pane\norca-3-pane\n'
    })
  })

  it('splits the leader when no session is given and never reuses closed pane ids', async () => {
    const { it2, api } = createIt2Fixture()

    await it2('session', 'split', '-v')
    expect(api.splitTerminal).toHaveBeenLastCalledWith('leader-handle', expect.anything())
    await it2('session', 'close', '-f', '-s', 'orca-2-pane')

    await expect(it2('session', 'split', '-v')).resolves.toMatchObject({
      stdout: 'Created new pane: orca-3-pane\n'
    })
  })

  it('keeps the it2 identity out of the env teammate panes inherit', async () => {
    const { it2, api, launch } = createIt2Fixture()
    expect(launch.env.ITERM_SESSION_ID).toBe('w0t0p0:orca-1-pane')

    await it2('session', 'split', '-v')

    const teammateEnv = vi.mocked(api.splitTerminal).mock.calls[0]?.[1].env
    expect(teammateEnv?.PATH).toBe(`/tmp/orca-shim${delimiter}/usr/bin`)
    expect(teammateEnv).not.toHaveProperty('ITERM_SESSION_ID')
    expect(teammateEnv).not.toHaveProperty('ORCA_AGENT_TEAMS_IT2_SHIM_DIR')
    expect(teammateEnv).not.toHaveProperty('ORCA_AGENT_TEAMS_IT2_PROBE_SHELL')
  })

  it('refuses to close the leader session', async () => {
    const { it2, api } = createIt2Fixture()

    await expect(it2('session', 'close', '-f', '-s', 'orca-1-pane')).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      stderr: 'it2: refusing to close leader session\n'
    })
    expect(api.closeTerminal).not.toHaveBeenCalled()
  })

  it('fails commands aimed at a session that no longer exists', async () => {
    const { it2 } = createIt2Fixture()
    await it2('session', 'split', '-v')
    await it2('session', 'close', '-f', '-s', 'orca-2-pane')

    await expect(it2('session', 'split', '-s', 'orca-2-pane')).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      stderr: 'it2: unknown session: orca-2-pane\n'
    })
    await expect(it2('session', 'run', '-s', 'orca-2-pane', 'ls')).resolves.toMatchObject({
      ok: false,
      exitCode: 1
    })
  })

  it('drops a teammate session that can no longer be split so Claude retries from another', async () => {
    const { it2, api } = createIt2Fixture()
    await it2('session', 'split', '-v')
    vi.mocked(api.splitTerminal).mockRejectedValueOnce(new Error('terminal is gone'))

    await expect(it2('session', 'split', '-s', 'orca-2-pane')).resolves.toMatchObject({
      ok: false,
      exitCode: 1
    })
    await expect(it2('session', 'list')).resolves.toMatchObject({ stdout: 'orca-1-pane\n' })
  })

  it('keeps a session registered when its process stop is unconfirmed', async () => {
    const { it2, api } = createIt2Fixture()
    await it2('session', 'split', '-v')
    vi.mocked(api.closeTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      tabId: 'tab-1',
      ptyKilled: false
    })

    await expect(it2('session', 'close', '-f', '-s', 'orca-2-pane')).resolves.toMatchObject({
      ok: false,
      exitCode: 1
    })
    await expect(it2('session', 'list')).resolves.toMatchObject({
      stdout: 'orca-1-pane\norca-2-pane\n'
    })
  })

  it('fails run when the terminal refuses the input', async () => {
    const { it2, api } = createIt2Fixture()
    await it2('session', 'split', '-v')
    vi.mocked(api.sendTerminal).mockResolvedValueOnce({
      handle: 'teammate-1',
      accepted: false,
      bytesWritten: 0
    })

    await expect(it2('session', 'run', '-s', 'orca-2-pane', 'ls')).resolves.toMatchObject({
      ok: false,
      exitCode: 1
    })
  })

  it('rejects unsupported it2 commands', async () => {
    const { it2 } = createIt2Fixture()

    await expect(it2('profile', 'list')).resolves.toMatchObject({
      ok: false,
      stderr: 'it2: unsupported it2 command: profile list\n'
    })
  })
})
