import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { buildCurrentWorktreeSelector, main, normalizeWorktreeSelector } from './index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('builds the current worktree selector from cwd', () => {
    expect(buildCurrentWorktreeSelector('/tmp/repo/feature')).toBe(
      `path:${path.resolve('/tmp/repo/feature')}`
    )
  })

  it('normalizes active/current worktree selectors to cwd', () => {
    const resolved = path.resolve('/tmp/repo/feature')
    expect(normalizeWorktreeSelector('active', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('current', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('branch:feature/foo', '/tmp/repo/feature')).toBe(
      'branch:feature/foo'
    )
  })

  it('shows the enclosing worktree for `worktree current`', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([
        buildWorktree('/tmp/repo', 'main'),
        buildWorktree('/tmp/repo/feature', 'feature/foo'),
        buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'duplicate-repo')
      ]),
      okFixture('req_1', {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature'
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: 'id:repo::/tmp/repo/feature'
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('resolves the invocation cwd from ORCA_CLI_CWD when no cwd is passed', async () => {
    // Why: the SSH relay bridge runs the CLI on the Orca host with the remote
    // shell's cwd carried in ORCA_CLI_CWD (#7716); cwd-based selectors must
    // resolve against it, not the host process cwd.
    process.env.ORCA_CLI_CWD = '/tmp/repo/feature/src'
    try {
      queueFixtures(
        callMock,
        worktreeListFixture([
          buildWorktree('/tmp/repo', 'main'),
          buildWorktree('/tmp/repo/feature', 'feature/foo')
        ]),
        okFixture('req_1', {
          worktree: {
            id: 'repo::/tmp/repo/feature',
            branch: 'feature/foo',
            path: '/tmp/repo/feature'
          }
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['worktree', 'current', '--json'])

      expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
        worktree: 'id:repo::/tmp/repo/feature'
      })
    } finally {
      delete process.env.ORCA_CLI_CWD
    }
  })

  it.skipIf(process.platform === 'win32')(
    'prepares and starts Claude Agent Teams in the current Orca terminal',
    async () => {
      process.env.ORCA_PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
      queueFixtures(
        callMock,
        okFixture('req_agent_teams_prepare', {
          launch: {
            env: {
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              TMUX: '/tmp/orca-claude-agent-teams/team-1,0,1',
              TMUX_PANE: '%1',
              PATH: '/tmp/orca-shim:/usr/bin'
            }
          }
        })
      )

      await main(['claude-teams'], '/tmp/repo')

      expect(callMock).toHaveBeenCalledWith('agentTeams.prepareLaunch', {
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        env: expect.objectContaining({
          ORCA_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111'
        })
      })
      expect(spawnMock).toHaveBeenCalledWith('claude', ['--teammate-mode', 'auto'], {
        stdio: 'inherit',
        env: expect.objectContaining({
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          TMUX_PANE: '%1'
        })
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'passes Claude Agent Teams arguments through to Claude Code',
    async () => {
      process.env.ORCA_PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
      queueFixtures(
        callMock,
        okFixture('req_agent_teams_prepare', {
          launch: {
            env: {
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              TMUX: '/tmp/orca-claude-agent-teams/team-1,0,1',
              TMUX_PANE: '%1',
              PATH: '/tmp/orca-shim:/usr/bin'
            }
          }
        })
      )

      await main(
        ['claude-teams', '--resume', 'session-1', '--model', 'sonnet', 'review this'],
        '/tmp/repo'
      )

      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        ['--teammate-mode', 'auto', '--resume', 'session-1', '--model', 'sonnet', 'review this'],
        {
          stdio: 'inherit',
          env: expect.objectContaining({
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            TMUX_PANE: '%1'
          })
        }
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not duplicate an explicit Claude teammate mode',
    async () => {
      process.env.ORCA_PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
      queueFixtures(
        callMock,
        okFixture('req_agent_teams_prepare', {
          launch: {
            env: {
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              TMUX: '/tmp/orca-claude-agent-teams/team-1,0,1',
              TMUX_PANE: '%1',
              PATH: '/tmp/orca-shim:/usr/bin'
            }
          }
        })
      )

      await main(['claude-teams', '--teammate-mode', 'in-process'], '/tmp/repo')

      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        ['--teammate-mode', 'in-process'],
        expect.objectContaining({ stdio: 'inherit' })
      )
    }
  )

  it('rejects remote `worktree current` without listing worktrees from client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'current', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'current is a local cwd shortcut and cannot be resolved against a remote runtime.'
    )
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'id:<repo-id>::<path>'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('uses the resolved enclosing worktree for other worktree consumers', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_show', {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'show', '--worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: 'id:repo::/tmp/repo/feature'
    })
  })
})
