/* eslint-disable max-lines -- Why: CLI parser tests share one mocked runtime client and fixture queue; splitting this file would duplicate setup and make command coverage harder to audit. */
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode?: string | null,
      environmentSelector?: string | null
    ) {
      const effectivePairingCode =
        remotePairingCode === undefined
          ? (process.env.ORCA_PAIRING_CODE ?? process.env.ORCA_REMOTE_PAIRING)
          : remotePairingCode
      const effectiveEnvironment =
        environmentSelector === undefined ? process.env.ORCA_ENVIRONMENT : environmentSelector
      if (effectivePairingCode && effectiveEnvironment) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Use either --pairing-code or --environment, not both.'
        )
      }
      this.isRemote = Boolean(effectivePairingCode || effectiveEnvironment)
    }
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: serveOrcaAppMock,
    getDefaultUserDataPath: getDefaultUserDataPathMock
  }
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events')
  return {
    spawn: spawnMock.mockImplementation(() => {
      const child = new EventEmitter()
      process.nextTick(() => child.emit('exit', 0, null))
      return child
    })
  }
})

import {
  buildCurrentWorktreeSelector,
  COMMAND_SPECS,
  main,
  normalizeWorktreeSelector
} from './index'
import { GLOBAL_FLAGS } from './args'
import { RuntimeRpcFailureError } from './runtime-client'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'

describe('COMMAND_SPECS collision check', () => {
  it('has no duplicate command paths', () => {
    const seen = new Set<string>()
    for (const spec of COMMAND_SPECS) {
      const key = spec.path.join(' ')
      expect(seen.has(key), `Duplicate COMMAND_SPECS path: "${key}"`).toBe(false)
      seen.add(key)
    }
  })

  it('allows every flag documented in command usage strings', () => {
    const flagPattern = /--([a-zA-Z0-9-]+)/g
    for (const spec of COMMAND_SPECS) {
      const allowed = new Set([...GLOBAL_FLAGS, ...spec.allowedFlags])
      for (const match of spec.usage.matchAll(flagPattern)) {
        const flag = match[1]
        expect(
          allowed.has(flag),
          `Documented flag --${flag} is not allowed for command: ${spec.path.join(' ')}`
        ).toBe(true)
      }
    }
  })
})

describe('orca root help', () => {
  it('advertises computer-use capabilities discovery', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'], '/tmp/repo')

    expect(logSpy.mock.calls[0][0]).toContain(
      'computer capabilities     Show computer-use provider capabilities'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'computer permissions      Show or open computer-use permission setup'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'computer press-key        Press a single key such as Return or Escape'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-existing-folder Make a project available on a host by importing an existing folder'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-create      Create independent project host setup metadata'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-update      Update project host setup metadata'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-delete      Remove a project host setup'
    )
    expect(logSpy.mock.calls[0][0]).toContain('Agent Sessions And Worktrees:')
    expect(logSpy.mock.calls[0][0]).toContain(
      '`worktree create --agent` creates a new checkout with an agent.'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'orca terminal create --worktree active --command "codex"'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('progressively discloses Linear commands', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'], '/tmp/repo')

    const rootHelp = String(logSpy.mock.calls[0][0])
    expect(rootHelp).toContain('Linear:')
    expect(rootHelp).toContain('linear                    Read Linear ticket context for agents')
    expect(rootHelp).not.toContain('linear issue')
    expect(rootHelp).not.toContain('linear search')

    logSpy.mockClear()
    await main(['linear', '--help'], '/tmp/repo')

    const groupHelp = String(logSpy.mock.calls[0][0])
    expect(groupHelp).toContain('orca linear')
    expect(groupHelp).toContain('issue')
    expect(groupHelp).toContain('search')
    expect(groupHelp).not.toContain('--comments')
    expect(groupHelp).not.toContain('--attachments')

    logSpy.mockClear()
    await main(['linear', 'issue', '--help'], '/tmp/repo')

    const issueHelp = String(logSpy.mock.calls[0][0])
    expect(issueHelp).toContain('orca linear issue [<id>]')
    expect(issueHelp).toContain('--comments             Include threaded Linear comments')
    expect(issueHelp).toContain('--attachments          Include attachment metadata and URLs')
    expect(issueHelp).toContain('--workspace <id>      Connected Linear workspace id')
    expect(issueHelp).toContain('--id <id>             Linear issue key, id, or URL')

    logSpy.mockClear()
    await main(['linear', 'search', '--help'], '/tmp/repo')

    const searchHelp = String(logSpy.mock.calls[0][0])
    expect(searchHelp).toContain('orca linear search <query>')
    expect(searchHelp).toContain('--workspace <id|all>  Connected Linear workspace id, or all')
    expect(searchHelp).toContain('--query <text>        Text to search across Linear issues')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('advertises Linear issue linking on worktree create and set help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['worktree', 'create', '--help'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0][0])).toContain('--linear-issue <identifier-or-url>')

    logSpy.mockClear()
    await main(['worktree', 'set', '--help'], '/tmp/repo')

    const setHelp = String(logSpy.mock.calls[0][0])
    expect(setHelp).toContain('--linear-issue <identifier-or-url|null>')
    expect(setHelp).toContain('--linear-issue <id|url|null> Linked Linear issue identifier or URL')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('hides removed parent-workspace help and scopes create parent selectors', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['--help'], '/tmp/repo')

    const rootHelp = String(logSpy.mock.calls[0][0])
    expect(rootHelp).not.toContain('--parent-workspace')
    expect(rootHelp).toContain('[--parent-worktree <selector>] [--no-parent]')

    logSpy.mockClear()
    await main(['worktree', 'create', '--help'], '/tmp/repo')

    const createHelp = String(logSpy.mock.calls[0][0])
    expect(createHelp).not.toContain('--parent-workspace')
    expect(createHelp).not.toContain('checkout/workspace')
    expect(createHelp).not.toContain('caller workspace')
    expect(createHelp).not.toContain('current workspace')
    expect(createHelp).not.toContain('active Orca workspace')
    expect(createHelp).not.toContain('folderWorkspaceId')
    expect(createHelp).toContain('folder:<id>')
    expect(createHelp).toContain('folder:<folderId>')
    expect(createHelp).toContain('worktree:<id>')

    logSpy.mockClear()
    await main(['worktree', 'set', '--help'], '/tmp/repo')

    const setHelp = String(logSpy.mock.calls[0][0])
    expect(setHelp).not.toContain('--parent-workspace')
    expect(setHelp).not.toContain('folder:<id>')
    expect(setHelp).not.toContain('worktree:<id>')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('distinguishes new worktrees from fresh agent terminals in command help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['worktree', 'create', '--help'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0][0])).toContain('This creates a new checkout.')
    expect(String(logSpy.mock.calls[0][0])).toContain(
      'orca terminal create --worktree active --command "codex"'
    )

    logSpy.mockClear()
    await main(['terminal', 'create', '--help'], '/tmp/repo')

    const terminalHelp = String(logSpy.mock.calls[0][0])
    expect(terminalHelp).toContain('Use this, not worktree create')
    expect(terminalHelp).toContain(
      'orca terminal create --worktree active --command "codex" --json'
    )
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orca cli worktree awareness', () => {
  const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
  const originalUserDataPath = process.env.ORCA_USER_DATA_PATH
  const originalPairingCode = process.env.ORCA_PAIRING_CODE
  const originalRemotePairing = process.env.ORCA_REMOTE_PAIRING
  const originalEnvironment = process.env.ORCA_ENVIRONMENT
  const originalWorkspaceId = process.env.ORCA_WORKSPACE_ID
  const originalWorktreeId = process.env.ORCA_WORKTREE_ID

  beforeEach(() => {
    callMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_USER_DATA_PATH
    delete process.env.ORCA_WORKSPACE_ID
    delete process.env.ORCA_WORKTREE_ID
    serveOrcaAppMock.mockReset()
    getDefaultUserDataPathMock.mockClear()
    addEnvironmentFromPairingCodeMock.mockReset()
    listEnvironmentsMock.mockReset()
    spawnMock.mockClear()
    addEnvironmentFromPairingCodeMock.mockReturnValue({
      id: 'env-1',
      name: 'desk',
      createdAt: 100,
      updatedAt: 100,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [
        {
          id: 'ws-env-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'ws://127.0.0.1:6768',
          deviceToken: 'token',
          publicKeyB64: 'pk'
        }
      ],
      preferredEndpointId: 'ws-env-1'
    })
    listEnvironmentsMock.mockReturnValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
    if (originalUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = originalUserDataPath
    }
    if (originalPairingCode === undefined) {
      delete process.env.ORCA_PAIRING_CODE
    } else {
      process.env.ORCA_PAIRING_CODE = originalPairingCode
    }
    if (originalRemotePairing === undefined) {
      delete process.env.ORCA_REMOTE_PAIRING
    } else {
      process.env.ORCA_REMOTE_PAIRING = originalRemotePairing
    }
    if (originalEnvironment === undefined) {
      delete process.env.ORCA_ENVIRONMENT
    } else {
      process.env.ORCA_ENVIRONMENT = originalEnvironment
    }
    if (originalWorkspaceId === undefined) {
      delete process.env.ORCA_WORKSPACE_ID
    } else {
      process.env.ORCA_WORKSPACE_ID = originalWorkspaceId
    }
    if (originalWorktreeId === undefined) {
      delete process.env.ORCA_WORKTREE_ID
    } else {
      process.env.ORCA_WORKTREE_ID = originalWorktreeId
    }
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
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('uses cwd when active is passed to worktree.set', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([
        buildWorktree('/tmp/repo', 'main', 'aaa'),
        buildWorktree('/tmp/repo/feature', 'feature/foo')
      ]),
      okFixture('req_1', {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature',
          comment: 'hello'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'active', '--comment', 'hello', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.set', {
      worktree: 'id:repo::/tmp/repo/feature',
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'hello',
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('passes parent lineage through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: 'repo::/tmp/repo/parent',
          childWorktreeIds: [],
          lineage: {
            worktreeId: 'repo::/tmp/repo/child',
            worktreeInstanceId: 'child-instance',
            parentWorktreeId: 'repo::/tmp/repo/parent',
            parentWorktreeInstanceId: 'parent-instance',
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--parent-worktree',
        'id:repo::/tmp/repo/parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      parentWorktree: 'id:repo::/tmp/repo/parent',
      noParent: false
    })
  })

  it('resolves current for explicit parent-worktree on set', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/parent', 'feature/parent')]),
      okFixture('req_set_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: 'repo::/tmp/repo/parent',
          childWorktreeIds: [],
          lineage: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--parent-worktree',
        'current',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      parentWorktree: 'id:repo::/tmp/repo/parent',
      noParent: false
    })
  })

  it('rejects contradictory parent flags on worktree.set before resolving selectors', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--parent-worktree',
        'current',
        '--no-parent',
        '--json'
      ],
      '/tmp/not-managed'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either --parent-worktree or --no-parent, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects bare parent-worktree on worktree.set', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--parent-worktree', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing required --parent-worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes parent removal through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_clear_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--no-parent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: true
    })
  })

  it('passes Linear URL metadata through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_linear', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          linkedLinearIssue: 'STA-335',
          linkedLinearIssueWorkspaceId: null,
          linkedLinearIssueOrganizationUrlKey: 'stably'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--linear-issue',
        'https://linear.app/stably/issue/STA-335/test-issue',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: 'stably',
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('clears all Linear metadata through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_clear_linear', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          linkedLinearIssue: null,
          linkedLinearIssueWorkspaceId: null,
          linkedLinearIssueOrganizationUrlKey: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--linear-issue',
        'null',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null,
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('rejects invalid Linear issue values on worktree.set before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--linear-issue',
        'not-a-linear-link',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Pass a Linear issue identifier like STA-335'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes workspace status through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_status', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          workspaceStatus: 'in-review'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--workspace-status',
        'in-review',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      workspaceStatus: 'in-review',
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('passes Linear issue metadata through worktree.create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_linear', {
        worktree: {
          ...buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1'),
          linkedLinearIssue: 'STA-335',
          linkedLinearIssueWorkspaceId: null,
          linkedLinearIssueOrganizationUrlKey: 'stably'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'https://linear.app/stably/issue/STA-335/test-issue',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      baseBranch: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: 'stably',
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('normalizes bare Linear identifiers through worktree.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create_linear_id', {
        worktree: {
          ...buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1'),
          linkedLinearIssue: 'STA-335'
        },
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'sta-335',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      baseBranch: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: true,
      callerTerminalHandle: undefined
    })
  })

  it('rejects null Linear issue values on worktree.create before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'null',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Omit --linear-issue on create'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects invalid Linear issue values on worktree.create before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'not-a-linear-link',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Pass a Linear issue identifier like STA-335'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects missing Linear issue values on worktree.create before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --linear-issue'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes explicit activation through worktree.create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'feature', '--activate', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: true,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('resolves project and host flags to the matching repo for worktree.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-local',
            projectId: 'github:stablyai/orca',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/srv/orca/feature', 'feature', 'abc', 'repo-gpu'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--project',
        'github:stablyai/orca',
        '--host',
        'runtime:gpu',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'projectHostSetup.list')
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-gpu',
      name: 'feature',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: true,
      callerTerminalHandle: undefined
    })
  })

  it('resolves project-host-setup directly for worktree.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/srv/orca/feature', 'feature', 'abc', 'repo-gpu'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--project-host-setup',
        'setup-gpu',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-gpu' })
    )
  })

  it('rejects mixing repo and project target flags on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-local',
        '--project',
        'github:stablyai/orca',
        '--name',
        'feature',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either --repo or project target flags, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes an explicit parent through worktree.create without cwd inference', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          parentWorktreeId: 'repo-1::/tmp/repo/parent',
          lineage: {
            worktreeId: 'repo-1::/tmp/repo/child',
            worktreeInstanceId: 'child-instance',
            parentWorktreeId: 'repo-1::/tmp/repo/parent',
            parentWorktreeInstanceId: 'parent-instance',
            origin: 'cli',
            capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
            createdAt: 1
          }
        },
        lineage: {
          worktreeId: 'repo-1::/tmp/repo/child',
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: 'repo-1::/tmp/repo/parent',
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        },
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--parent-worktree',
        'id:repo-1::/tmp/repo/parent',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: 'id:repo-1::/tmp/repo/parent',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('routes traditional parent-worktree selectors through parentWorktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          parentWorktreeId: 'repo-1::/tmp/repo/parent'
        },
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--parent-worktree',
        'branch:feature/parent',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: 'branch:feature/parent',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('routes workspace-key parent-worktree selectors through parentWorkspace', async () => {
    const cases = [
      { selector: 'folder:folder-1', parentWorkspace: 'folder:folder-1' },
      {
        selector: 'worktree:repo-1::/tmp/repo/parent',
        parentWorkspace: 'worktree:repo-1::/tmp/repo/parent'
      },
      { selector: 'id:folder:folder-1', parentWorkspace: 'folder:folder-1' },
      {
        selector: 'id:worktree:repo-1::/tmp/repo/parent',
        parentWorkspace: 'worktree:repo-1::/tmp/repo/parent'
      }
    ]
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const testCase of cases) {
      callMock.mockReset()
      queueFixtures(
        callMock,
        okFixture('req_create', {
          worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          lineage: null,
          workspaceLineage: {
            childWorkspaceKey: 'worktree:repo-1::/tmp/repo/child',
            childInstanceId: 'child-instance',
            parentWorkspaceKey: testCase.parentWorkspace,
            parentInstanceId: null,
            origin: 'cli',
            capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
            createdAt: 1
          },
          warnings: []
        })
      )

      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'child',
          '--parent-worktree',
          testCase.selector,
          '--json'
        ],
        '/tmp/repo/parent/src'
      )

      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith('worktree.create', {
        repo: 'id:repo-1',
        name: 'child',
        baseBranch: undefined,
        linkedIssue: undefined,
        comment: undefined,
        runHooks: false,
        activate: false,
        parentWorktree: undefined,
        parentWorkspace: testCase.parentWorkspace,
        noParent: false,
        callerTerminalHandle: undefined
      })
    }
  })

  it('passes folder workspace environment lineage through worktree.create', async () => {
    process.env.ORCA_WORKSPACE_ID = 'folder:folder-1'
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        workspaceLineage: {
          childWorkspaceKey: 'worktree:repo-1::/tmp/repo/child',
          childInstanceId: 'child-instance',
          parentWorkspaceKey: 'folder:folder-1',
          parentInstanceId: null,
          origin: 'cli',
          capture: { source: 'env-workspace', confidence: 'inferred' },
          createdAt: 1
        },
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      envParentWorkspace: 'folder:folder-1',
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('resolves current for explicit parent-worktree on create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/parent', 'feature/parent', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--parent-worktree',
        'current',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: 'id:repo-1::/tmp/repo/parent',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('routes active/current folder workspace parent selectors through parentWorkspace on create', async () => {
    const folderWorkspace = {
      ...buildWorktree('/tmp/folder', '', '', 'folder-workspace:group-1'),
      id: 'folder:folder-1',
      repoId: 'folder-workspace:group-1',
      displayName: 'Folder'
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const parentSelector of ['current', 'active']) {
      callMock.mockReset()
      queueFixtures(
        callMock,
        worktreeListFixture([folderWorkspace]),
        okFixture('req_create', {
          worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          lineage: null,
          workspaceLineage: {
            childWorkspaceKey: 'worktree:repo-1::/tmp/repo/child',
            childInstanceId: 'child-instance',
            parentWorkspaceKey: 'folder:folder-1',
            parentInstanceId: null,
            origin: 'cli',
            capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
            createdAt: 1
          },
          warnings: []
        })
      )

      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'child',
          '--parent-worktree',
          parentSelector,
          '--json'
        ],
        '/tmp/folder/src'
      )

      expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
        repo: 'id:repo-1',
        name: 'child',
        baseBranch: undefined,
        linkedIssue: undefined,
        comment: undefined,
        runHooks: false,
        activate: false,
        parentWorktree: undefined,
        parentWorkspace: 'folder:folder-1',
        noParent: false,
        callerTerminalHandle: undefined
      })
    }
  })

  it('rejects contradictory parent flags on worktree.create before resolving selectors', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--parent-worktree',
        'current',
        '--no-parent',
        '--json'
      ],
      '/tmp/not-managed'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either one parent selector or --no-parent.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects removed parent-workspace on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    const outputModes = [[], ['--json']]

    for (const outputArgs of outputModes) {
      logSpy.mockClear()
      errSpy.mockClear()
      process.exitCode = priorExitCode

      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'child',
          '--parent-workspace',
          'folder:folder-1',
          ...outputArgs
        ],
        '/tmp/repo'
      )

      const output = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
      expect(output).toContain('Unknown flag --parent-workspace for command: worktree create')
      expect(callMock).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
    }

    process.exitCode = priorExitCode
  })

  it('rejects bare parent-worktree on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--parent-worktree',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing required --parent-worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('reports runtime parent selector failures without hidden flag guidance', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_create',
        ok: false,
        error: {
          code: 'LINEAGE_PARENT_NOT_FOUND',
          message: 'Parent selector was not found.',
          data: {
            nextSteps: [
              'Pass a valid --parent-worktree selector such as folder:<id>, worktree:<id>, id:<worktreeId>, branch:<branch>, issue:<number>, path:<absolute-path>, or active/current.',
              'Retry with --no-parent to create without lineage.'
            ]
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--parent-worktree',
        'folder:missing',
        '--json'
      ],
      '/tmp/repo'
    )

    const output = String(logSpy.mock.calls[0][0])
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      parentWorkspace: 'folder:missing',
      noParent: false,
      callerTerminalHandle: undefined
    })
    expect(output).toContain('"ok": false')
    expect(output).toContain('Parent selector was not found.')
    expect(output).toContain('--parent-worktree selector')
    expect(output).not.toContain('--parent-workspace')
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes no-parent through worktree.create and skips cwd inference', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--no-parent', '--json'],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: true,
      callerTerminalHandle: undefined
    })
  })

  it('passes caller terminal handle through worktree.create with cwd fallback', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_parent'
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: 'term_parent'
    })
  })

  it('starts a foreground headless server through `serve`', async () => {
    serveOrcaAppMock.mockResolvedValue(0)
    process.env.ORCA_ENVIRONMENT = 'stale-env'

    await main(
      ['serve', '--json', '--port', '6768', '--pairing-address', '100.64.1.20', '--no-pairing'],
      '/tmp/repo'
    )

    expect(serveOrcaAppMock).toHaveBeenCalledWith({
      json: true,
      port: '6768',
      pairingAddress: '100.64.1.20',
      noPairing: true,
      mobilePairing: false
    })
  })

  it('starts a foreground headless server with mobile pairing enabled', async () => {
    serveOrcaAppMock.mockResolvedValue(0)

    await main(
      ['serve', '--pairing-address', '100.64.1.20', '--mobile-pairing', '--json'],
      '/tmp/repo'
    )

    expect(serveOrcaAppMock).toHaveBeenCalledWith({
      json: true,
      port: null,
      pairingAddress: '100.64.1.20',
      noPairing: false,
      mobilePairing: true
    })
  })

  it('rejects contradictory serve pairing flags', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--mobile-pairing', '--no-pairing', '--json'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --mobile-pairing or --no-pairing, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects invalid serve ports before launching the app', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--port', 'not-a-port', '--json'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Invalid --port value: not-a-port'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects value-less serve ports before launching the app', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--port', '--json'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --port.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('lists saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    listEnvironmentsMock.mockReturnValue([addEnvironmentFromPairingCodeMock()])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'list', '--json'], '/tmp/repo')

    expect(listEnvironmentsMock).toHaveBeenCalledWith('/tmp/orca-user-data')
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })

  it('adds saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['environment', 'add', '--name', 'desk', '--pairing-code', 'orca://pair#abc', '--json'],
      '/tmp/repo'
    )

    expect(addEnvironmentFromPairingCodeMock).toHaveBeenCalledWith('/tmp/orca-user-data', {
      name: 'desk',
      pairingCode: 'orca://pair#abc'
    })
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })

  it('resolves repo.add paths against the invoking cli cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: path.resolve('/tmp/repo/apps/web'),
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', './apps/web', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: path.resolve('/tmp/repo/apps/web')
    })
  })

  it('lists projects through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_list', {
        projects: [
          {
            id: 'github:stablyai/orca',
            displayName: 'Orca',
            badgeColor: '#7c3aed',
            providerIdentity: {
              provider: 'github',
              owner: 'stablyai',
              repo: 'orca'
            },
            sourceRepoIds: ['repo-1'],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'list', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('project.list')
  })

  it('filters project host setups locally after fetching setup compatibility state', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-local',
            projectId: 'github:stablyai/orca',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-remote',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: 'repo-remote',
            path: '/srv/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'setups', '--project', 'github:stablyai/orca', '--host', 'runtime:gpu'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.list')
    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-remote')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('setup-local')
  })

  it('sets up an existing project folder with a path resolved against the local cli cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup', {
        result: {
          project: {
            id: 'github:stablyai/orca',
            displayName: 'Orca',
            badgeColor: '#7c3aed',
            sourceRepoIds: ['repo-1'],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-local',
            projectId: 'github:stablyai/orca',
            hostId: 'local',
            repoId: 'repo-1',
            path: path.resolve('/tmp/orca'),
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 1
          },
          repo: {
            id: 'repo-1',
            path: path.resolve('/tmp/orca'),
            displayName: 'Orca',
            badgeColor: '#7c3aed',
            addedAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-existing-folder',
        '--project',
        'github:stablyai/orca',
        '--host',
        'local',
        '--path',
        '..',
        '--kind',
        'git',
        '--display-name',
        'Orca',
        '--json'
      ],
      '/tmp/orca/worktrees/feature'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.setupExistingFolder', {
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      path: path.resolve('/tmp/orca/worktrees'),
      kind: 'git',
      displayName: 'Orca'
    })
  })

  it('rejects remote project setup relative paths instead of resolving against client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'project',
        'setup-existing-folder',
        '--project',
        'github:stablyai/orca',
        '--host',
        'runtime:gpu',
        '--path',
        './orca',
        '--pairing-code',
        'remote-runtime',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Remote project setup requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects remote repo.add relative paths instead of resolving against client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['repo', 'add', '--path', './apps/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Remote repo add requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('sends remote repo.add absolute paths unchanged', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: '/srv/orca/web',
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['repo', 'add', '--path', '/srv/orca/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: '/srv/orca/web'
    })
  })

  it.each(['C:\\repo', 'C:/repo', '\\\\server\\share\\repo', '//server/share/repo'])(
    'sends remote repo.add server absolute path %s unchanged',
    async (serverPath) => {
      queueFixtures(
        callMock,
        okFixture('req_repo_add', {
          repo: {
            id: 'repo-1',
            path: serverPath,
            displayName: 'web'
          }
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(
        ['repo', 'add', '--path', serverPath, '--pairing-code', 'remote-runtime', '--json'],
        '/tmp/repo'
      )

      expect(callMock).toHaveBeenCalledWith('repo.add', {
        path: serverPath
      })
    }
  )

  it('opts into setup and activation when worktree.create runs hooks', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'feature', '--run-hooks', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: true,
      activate: true,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined
    })
  })

  it('passes agent prompt and setup policy through worktree.create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'agent-task',
        '--agent',
        'codex',
        '--prompt',
        'hi',
        '--setup',
        'run',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'agent-task',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: true,
      setupDecision: 'run',
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined,
      startupAgent: 'codex',
      startupPrompt: 'hi'
    })
  })

  it('infers the repo from the current worktree on worktree.create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--name',
        'agent-task',
        '--agent',
        'codex',
        '--prompt',
        'hi',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'agent-task',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: true,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined,
      startupAgent: 'codex',
      startupPrompt: 'hi'
    })
  })

  it('rejects prompt without agent on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--prompt', 'hi', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--prompt requires --agent'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects unknown agents on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--agent', 'wat', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Unknown TUI agent "wat"'
      }
    })
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects agent, prompt, and setup flags without values on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--agent'],
      '/tmp/repo'
    )
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --agent'
    )

    callMock.mockClear()
    logSpy.mockClear()
    errSpy.mockClear()
    process.exitCode = priorExitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--agent',
        'codex',
        '--prompt'
      ],
      '/tmp/repo'
    )
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --prompt'
    )

    callMock.mockClear()
    logSpy.mockClear()
    errSpy.mockClear()
    process.exitCode = priorExitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--setup'],
      '/tmp/repo'
    )
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --setup'
    )

    process.exitCode = priorExitCode
  })

  it('rejects contradictory setup flags on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--run-hooks',
        '--setup',
        'skip',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either --run-hooks or --setup run'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes explicit focus through terminal.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'RUNNER'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'RUNNER',
        '--focus',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: undefined,
      title: 'RUNNER',
      focus: true
    })
  })

  it('prints terminal.read fallback screen lines in json mode', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_read', {
        terminal: {
          handle: 'term_worker',
          status: 'running',
          tail: ['Claude Code', 'Checking files', 'Waiting for input'],
          truncated: false,
          limited: true,
          oldestCursor: '0',
          nextCursor: '3000',
          latestCursor: '3000',
          returnedLineCount: 3
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['terminal', 'read', '--terminal', 'term_worker', '--limit', '120', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.read', {
      terminal: 'term_worker',
      limit: 120
    })
    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.terminal.tail).toEqual([
      'Claude Code',
      'Checking files',
      'Waiting for input'
    ])
  })

  it('keeps interactive Codex startup commands backgrounded unless focus is explicit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex',
        '--command',
        'codex',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex',
      title: 'Codex',
      focus: false,
      rendererBacked: true,
      activate: false
    })
  })

  it('keeps explicit focus semantics when forcing Codex through the renderer path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex',
        '--command',
        'codex',
        '--focus',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex',
      title: 'Codex',
      focus: true,
      rendererBacked: true,
      activate: true
    })
  })

  it('does not force the visible terminal path for explicit Codex exec commands', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex exec'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex exec',
        '--command',
        'codex exec summarize',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex exec summarize',
      title: 'Codex exec',
      focus: false
    })
  })

  it('does not force the visible terminal path for Codex exec commands after global options', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex exec'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex exec',
        '--command',
        'codex -m gpt-5 --sandbox workspace-write exec summarize',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex -m gpt-5 --sandbox workspace-write exec summarize',
      title: 'Codex exec',
      focus: false
    })
  })

  it('does not force the visible terminal path for Codex review commands after long options', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex review'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex review',
        '--command',
        'codex --model=gpt-5 --sandbox=workspace-write review',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex --model=gpt-5 --sandbox=workspace-write review',
      title: 'Codex review',
      focus: false
    })
  })

  it('does not force the visible terminal path for Codex help commands', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex help'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex help',
        '--command',
        'codex --help',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex --help',
      title: 'Codex help',
      focus: false
    })
  })

  it('keeps Codex prompts after global options backgrounded unless focus is explicit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex prompt'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex prompt',
        '--command',
        'codex -m gpt-5 "fix the flaky test"',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex -m gpt-5 "fix the flaky test"',
      title: 'Codex prompt',
      focus: false,
      rendererBacked: true,
      activate: false
    })
  })

  it('keeps interactive Claude startup commands backgrounded unless focus is explicit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Claude'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Claude',
        '--command',
        'claude',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'claude',
      title: 'Claude',
      focus: false,
      rendererBacked: true,
      activate: false
    })
  })

  it('keeps Claude print commands on the background terminal path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Claude print'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Claude print',
        '--command',
        'claude -p "summarize"',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'claude -p "summarize"',
      title: 'Claude print',
      focus: false
    })
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

  it('formats group orchestration sends in text mode', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    callMock.mockResolvedValueOnce({
      id: 'req_send',
      ok: true,
      result: {
        messages: [{ id: 'msg_1' }, { id: 'msg_2' }],
        recipients: 2
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['orchestration', 'send', '--to', '@all', '--subject', 'hello'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_sender',
      to: '@all',
      subject: 'hello',
      body: undefined,
      type: undefined,
      priority: undefined,
      threadId: undefined,
      payload: undefined,
      devMode: false
    })
    expect(logSpy).toHaveBeenCalledWith('Sent 2 messages to 2 recipients')
  })

  it('passes all reset scope explicitly for no-flag orchestration reset', async () => {
    callMock.mockResolvedValueOnce(okFixture('req_reset', { reset: 'all' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['orchestration', 'reset'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: true,
      tasks: undefined,
      messages: undefined
    })
  })

  it.each([
    {
      args: ['orchestration', 'reset', '--all'],
      params: { all: true, tasks: undefined, messages: undefined },
      reset: 'all'
    },
    {
      args: ['orchestration', 'reset', '--tasks'],
      params: { all: undefined, tasks: true, messages: undefined },
      reset: 'tasks'
    },
    {
      args: ['orchestration', 'reset', '--messages'],
      params: { all: undefined, tasks: undefined, messages: true },
      reset: 'messages'
    },
    {
      args: ['orchestration', 'reset', '--tasks', '--messages'],
      params: { all: undefined, tasks: true, messages: true },
      reset: 'tasks'
    },
    {
      args: ['orchestration', 'reset', '--all', '--tasks'],
      params: { all: true, tasks: true, messages: undefined },
      reset: 'all'
    }
  ])('passes explicit reset flags through for $args', async ({ args, params, reset }) => {
    callMock.mockResolvedValueOnce(okFixture('req_reset', { reset }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(args, '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.reset', params)
  })

  it('rejects unknown task-update status with an enum-aware error', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['orchestration', 'task-update', '--id', 'task_x', '--status', 'complete'],
      '/tmp/repo'
    )

    const output = [...errSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n')
    expect(output).toContain("invalid status 'complete'")
    expect(output).toContain('pending, ready, dispatched, completed, failed, blocked')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)

    // Reset exitCode so subsequent tests don't inherit the failure.
    process.exitCode = priorExitCode
    errSpy.mockRestore()
  })

  it('passes the caller terminal handle through orchestration task-create', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock.mockResolvedValueOnce({
      id: 'req_task_create',
      ok: true,
      result: {
        task: { id: 'task_1', status: 'ready' }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['orchestration', 'task-create', '--spec', 'spawn child workspace'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('orchestration.taskCreate', {
      spec: 'spawn child workspace',
      deps: undefined,
      parent: undefined,
      callerTerminalHandle: 'term_creator'
    })
  })

  it('passes dev mode to injected orchestration dispatches', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_sender'
    process.env.ORCA_USER_DATA_PATH = '/tmp/orca-dev'
    callMock.mockResolvedValueOnce({
      id: 'req_dispatch',
      ok: true,
      result: {
        dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['orchestration', 'dispatch', '--task', 'task_1', '--to', 'term_worker', '--inject'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.dispatch', {
      task: 'task_1',
      to: 'term_worker',
      from: 'term_sender',
      inject: true,
      devMode: true
    })
  })

  it('uses the resolved enclosing worktree for terminal consumers', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_term', { terminals: [], totalCount: 0, truncated: false })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'active', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.list', {
      worktree: 'id:repo::/tmp/repo/feature',
      limit: undefined
    })
  })

  it('rejects implicit remote terminal create instead of resolving from client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['terminal', 'create', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/client/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Remote terminal create requires --worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('sends explicit remote terminal create worktree selectors unchanged', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/srv/orca/feature',
          title: 'Server terminal'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'id:repo-1::/srv/orca/feature',
        '--pairing-code',
        'remote-runtime',
        '--json'
      ],
      '/tmp/client/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'id:repo-1::/srv/orca/feature',
      command: undefined,
      title: undefined,
      focus: false
    })
  })

  it('collects and formats memory diagnostics', async () => {
    queueFixtures(
      callMock,
      okFixture('req_memory', {
        app: {
          cpu: 1.25,
          memory: 1024 * 1024,
          main: { cpu: 0.5, memory: 512 * 1024 },
          renderer: { cpu: 0.5, memory: 384 * 1024 },
          other: { cpu: 0.25, memory: 128 * 1024 },
          history: [1024 * 1024]
        },
        worktrees: [
          {
            worktreeId: 'repo::/tmp/repo/feature',
            worktreeName: 'feature',
            repoId: 'repo',
            repoName: 'Orca',
            cpu: 2.5,
            memory: 1024 * 1024,
            sessions: [
              {
                sessionId: 'pty-1',
                paneKey: null,
                pid: 123,
                cpu: 2.5,
                memory: 1024 * 1024
              }
            ],
            history: [1024 * 1024]
          }
        ],
        host: {
          totalMemory: 8 * 1024 * 1024,
          freeMemory: 2 * 1024 * 1024,
          usedMemory: 6 * 1024 * 1024,
          memoryUsagePercent: 75,
          cpuCoreCount: 8,
          loadAverage1m: 1.25
        },
        totalCpu: 3.75,
        totalMemory: 2 * 1024 * 1024,
        collectedAt: 1000
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['diagnostics', 'memory'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('diagnostics.memory')
    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('totalMemory: 2.0 MB')
    expect(output).toContain('app: 1.0 MB')
    expect(output).toContain('- feature  1.0 MB  2.5%  1 session')
  })

  it('exits nonzero when terminal wait returns an unsatisfied blocked result', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValueOnce({
      id: 'req_terminal_wait',
      ok: true,
      result: {
        wait: {
          handle: 'term_worker',
          condition: 'tui-idle',
          satisfied: false,
          status: 'running',
          exitCode: null,
          blockedReason: 'codex-cwd-prompt'
        }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['terminal', 'wait', '--terminal', 'term_worker', '--for', 'tui-idle'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.wait',
      {
        terminal: 'term_worker',
        for: 'tui-idle',
        timeoutMs: undefined
      },
      {
        timeoutMs: 300000
      }
    )
    expect(logSpy.mock.calls.flat().join('\n')).toContain('blockedReason: codex-cwd-prompt')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('does not force remote Codex terminal creates through a local renderer path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/srv/orca/feature',
          title: 'Codex'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'id:repo-1::/srv/orca/feature',
        '--command',
        'codex',
        '--title',
        'Codex',
        '--pairing-code',
        'remote-runtime',
        '--json'
      ],
      '/tmp/client/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'id:repo-1::/srv/orca/feature',
      command: 'codex',
      title: 'Codex',
      focus: false
    })
  })

  it('does not resolve implicit remote browser targets from client cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_tab_current', {
        tab: {
          browserPageId: 'page-1',
          index: 0,
          url: 'https://example.com',
          title: 'Example',
          active: true,
          worktreeId: 'repo-1::/srv/orca/feature'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['tab', 'current', '--pairing-code', 'remote-runtime', '--json'], '/tmp/client/src')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('browser.tabCurrent', {
      worktree: undefined
    })
  })

  it('passes emulator gesture points through to the runtime', async () => {
    const points = [
      { type: 'begin', x: 0.5, y: 0.98, edge: 3 },
      { type: 'move', x: 0.5, y: 0.4, edge: 3 },
      { type: 'end', x: 0.5, y: 0.2, edge: 3 }
    ]
    queueFixtures(callMock, okFixture('req_emulator_gesture', { ok: true }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['emulator', 'gesture', JSON.stringify(points), '--worktree', 'id:wt-1', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('emulator.gesture', {
      points,
      device: undefined,
      emulator: undefined,
      worktree: 'id:wt-1'
    })
  })

  it('rejects emulator gesture points outside normalized coordinates', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'emulator',
        'gesture',
        JSON.stringify([
          { type: 'begin', x: 1.2, y: 0.8 },
          { type: 'end', x: 0.5, y: 0.2 }
        ]),
        '--worktree',
        'id:wt-1',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: '--points[0].x must be between 0 and 1'
      }
    })
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects emulator gesture points with invalid edge markers', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'emulator',
        'gesture',
        JSON.stringify([
          { type: 'begin', x: 0.5, y: 0.98, edge: 8 },
          { type: 'end', x: 0.5, y: 0.2, edge: 8 }
        ]),
        '--worktree',
        'id:wt-1',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'gesture point 0 edge must be an integer between 0 and 4'
      }
    })

    process.exitCode = priorExitCode
  })

  it('creates an automation for the enclosing worktree by default', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('req_automation_create', {
        automation: {
          id: 'auto-1',
          name: 'Daily review',
          prompt: 'Review open changes',
          agentId: 'codex',
          projectId: 'repo-1',
          executionTargetType: 'local',
          executionTargetId: 'local',
          schedulerOwner: 'local_host_service',
          workspaceMode: 'existing',
          workspaceId: 'repo-1::/tmp/repo/feature',
          baseBranch: null,
          timezone: 'America/Toronto',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: 1,
          enabled: true,
          nextRunAt: 2,
          missedRunPolicy: 'run_once_within_grace',
          missedRunGraceMinutes: 720,
          createdAt: 1,
          updatedAt: 1
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.create', {
      name: 'Daily review',
      prompt: 'Review open changes',
      agentId: 'codex',
      repo: undefined,
      workspace: 'id:repo-1::/tmp/repo/feature',
      workspaceMode: 'existing',
      baseBranch: undefined,
      reuseSession: undefined,
      timezone: undefined,
      enabled: undefined,
      missedRunGraceMinutes: undefined,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: expect.any(Number)
    })
  })

  it('resolves project and host flags for automation create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-local',
            projectId: 'github:stablyai/orca',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_automation_create', {
        automation: { id: 'auto-1', name: 'GPU review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'GPU review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--project',
        'github:stablyai/orca',
        '--host',
        'runtime:gpu',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'projectHostSetup.list')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'automation.create',
      expect.objectContaining({
        repo: 'id:repo-gpu',
        runContext: {
          kind: 'workspace-run',
          projectId: 'github:stablyai/orca',
          hostId: 'runtime:gpu',
          projectHostSetupId: 'setup-gpu',
          repoId: 'repo-gpu',
          path: '/srv/orca'
        },
        workspace: undefined,
        workspaceMode: 'new_per_run'
      })
    )
  })

  it('resolves project-host-setup flags for automation edit with explicit run context', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_edit', {
        automation: { id: 'auto-1', name: 'GPU review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', 'auto-1', '--project-host-setup', 'setup-gpu', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'projectHostSetup.list')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'automation.update',
      expect.objectContaining({
        id: 'auto-1',
        updates: expect.objectContaining({
          repo: 'id:repo-gpu',
          runContext: {
            kind: 'workspace-run',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            projectHostSetupId: 'setup-gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca'
          }
        })
      })
    )
  })

  it('passes automation source context JSON through create', async () => {
    const sourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu',
      projectHostSetupId: 'setup-gpu',
      repoId: 'repo-gpu',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
      accountLabel: 'gpu-bot'
    }
    queueFixtures(
      callMock,
      okFixture('req_automation_create', {
        automation: { id: 'auto-1', name: 'GPU task review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'GPU task review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open work',
        '--provider',
        'codex',
        '--repo',
        'id:repo-gpu',
        '--source-context',
        JSON.stringify(sourceContext),
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      1,
      'automation.create',
      expect.objectContaining({
        repo: 'id:repo-gpu',
        sourceContext
      })
    )
  })

  it('clears automation source context on edit with null', async () => {
    queueFixtures(
      callMock,
      okFixture('req_edit', {
        automation: { id: 'auto-1', name: 'GPU task review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--source-context', 'null', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      1,
      'automation.update',
      expect.objectContaining({
        id: 'auto-1',
        updates: expect.objectContaining({
          sourceContext: null
        })
      })
    )
  })

  it('rejects invalid automation source context JSON before calling the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'GPU task review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open work',
        '--provider',
        'codex',
        '--repo',
        'id:repo-gpu',
        '--source-context',
        '{nope',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--source-context must be valid JSON'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects invalid automation --day values before calling the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'Weekly review',
        '--trigger',
        'weekly',
        '--day',
        '7',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--day must be an integer from 0 to 6'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it.each([
    {
      name: 'day on daily preset',
      args: ['--trigger', 'daily', '--day', '2'],
      message: '--day can only be used with the weekly automation preset'
    },
    {
      name: 'time on custom cron',
      args: ['--trigger', '0 9 * * *', '--time', '10:30'],
      message: '--time can only be used with preset automation triggers'
    },
    {
      name: 'time on hourly preset',
      args: ['--trigger', 'hourly', '--time', '10:30'],
      message: '--time cannot be used with the hourly automation preset'
    }
  ])('rejects automation schedule modifier mismatch: $name', async ({ args, message }) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        ...args,
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(message)
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it.each([
    {
      name: 'create',
      args: [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--time',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--json'
      ]
    },
    {
      name: 'edit',
      args: ['automations', 'edit', 'auto-1', '--trigger', 'daily', '--time', '--json']
    }
  ])('rejects bare automation --time on $name', async ({ args }) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(args, '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--time must use HH:MM format'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects automation edit schedule modifiers without a schedule flag', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['automations', 'edit', 'auto-1', '--day', '7', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--day requires --trigger or --schedule'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects automation create with both repo and workspace targets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--repo',
        'id:repo-1',
        '--workspace',
        'id:repo-1::/tmp/repo/feature',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --repo or --workspace, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes automation session reuse flags through create and edit', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('req_create', {
        automation: { id: 'auto-1', name: 'Daily review' }
      }),
      okFixture('req_edit', {
        automation: { id: 'auto-1', name: 'Daily review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--workspace',
        'current',
        '--reuse-session',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )
    await main(['automations', 'edit', 'auto-1', '--fresh-session', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'automation.create',
      expect.objectContaining({
        workspace: 'id:repo-1::/tmp/repo/feature',
        workspaceMode: 'existing',
        reuseSession: true
      })
    )
    expect(callMock).toHaveBeenNthCalledWith(3, 'automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ reuseSession: false })
    })
  })

  it('rejects conflicting automation session reuse flags', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['automations', 'edit', 'auto-1', '--reuse-session', '--fresh-session', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --reuse-session or --fresh-session, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects automation edit with both repo and workspace targets', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'edit',
        'auto-1',
        '--repo',
        'id:repo-1',
        '--workspace',
        'id:repo-1::/tmp/repo/feature',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --repo or --workspace, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it.each([
    {
      flag: 'enabled',
      value: 'false',
      message: '--enabled does not take a value'
    },
    {
      flag: 'disabled',
      value: 'false',
      message: '--disabled does not take a value'
    }
  ])('rejects automation create --$flag with a string value', async ({ flag, value, message }) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--repo',
        'id:repo-1',
        `--${flag}`,
        value,
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(message)
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('resolves explicit automation create workspace active from cwd', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('req_automation_create', {
        automation: { id: 'auto-1', name: 'Daily review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--workspace',
        'active',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.create', {
      name: 'Daily review',
      prompt: 'Review open changes',
      agentId: 'codex',
      repo: undefined,
      workspace: 'id:repo-1::/tmp/repo/feature',
      workspaceMode: 'existing',
      baseBranch: undefined,
      timezone: undefined,
      enabled: undefined,
      missedRunGraceMinutes: undefined,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: expect.any(Number)
    })
  })

  it('resolves explicit automation edit workspace current from cwd', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      okFixture('req_edit', {
        automation: { id: 'auto-1', name: 'Daily review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', 'auto-1', '--workspace', 'current', '--enabled', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.update', {
      id: 'auto-1',
      updates: {
        name: undefined,
        prompt: undefined,
        agentId: undefined,
        repo: undefined,
        workspace: 'id:repo-1::/tmp/repo/feature',
        workspaceMode: undefined,
        baseBranch: undefined,
        reuseSession: undefined,
        timezone: undefined,
        enabled: true,
        missedRunGraceMinutes: undefined
      }
    })
  })

  it('passes positional automation ids to edit, remove, run, and show', async () => {
    queueFixtures(
      callMock,
      okFixture('req_edit', { automation: { id: 'auto-1', name: 'Paused' } }),
      okFixture('req_remove', { removed: true, id: 'auto-1' }),
      okFixture('req_run', {
        run: {
          id: 'run-1',
          automationId: 'auto-1',
          title: 'Paused run 1',
          status: 'pending',
          trigger: 'manual',
          scheduledFor: 1,
          workspaceId: null,
          sessionKind: 'terminal',
          chatSessionId: null,
          terminalSessionId: null,
          outputSnapshot: null,
          usage: null,
          error: null,
          startedAt: null,
          dispatchedAt: null,
          createdAt: 1
        }
      }),
      okFixture('req_show', { automation: { id: 'auto-1', name: 'Paused' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--disabled', '--json'], '/tmp/repo')
    await main(['automations', 'remove', 'auto-1', '--json'], '/tmp/repo')
    await main(['automations', 'run', 'auto-1', '--json'], '/tmp/repo')
    await main(['automations', 'show', 'auto-1', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'automation.update', {
      id: 'auto-1',
      updates: {
        name: undefined,
        prompt: undefined,
        agentId: undefined,
        repo: undefined,
        workspace: undefined,
        workspaceMode: undefined,
        baseBranch: undefined,
        timezone: undefined,
        enabled: false,
        missedRunGraceMinutes: undefined
      }
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.delete', {
      id: 'auto-1'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'automation.runNow', {
      id: 'auto-1'
    })
    expect(callMock).toHaveBeenNthCalledWith(4, 'automation.show', {
      id: 'auto-1'
    })
  })

  it('rejects ambiguous positional and flag automation ids before dispatch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['automations', 'show', 'auto-1', '--id', 'auto-2', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Pass --id either positionally or as a flag, not both.'
      }
    })
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('updates project host setup metadata through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup_update', {
        result: {
          project: {
            id: 'github:stablyai/orca',
            displayName: 'Orca',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '/srv/orca',
            displayName: 'GPU VM',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-update',
        '--setup',
        'setup-gpu',
        '--display-name',
        'GPU VM',
        '--path',
        '/srv/orca',
        '--worktree-base-path',
        '../worktrees',
        '--state',
        'ready',
        '--method',
        'imported-existing-folder',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.update', {
      setupId: 'setup-gpu',
      updates: {
        displayName: 'GPU VM',
        path: path.resolve('/tmp/repo', '/srv/orca'),
        worktreeBasePath: '../worktrees',
        gitUsername: undefined,
        kind: undefined,
        setupState: 'ready',
        setupMethod: 'imported-existing-folder'
      }
    })
  })

  it('creates independent project host setup metadata through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup_create', {
        result: {
          project: {
            id: 'github:stablyai/orca',
            displayName: 'Orca',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '',
            displayName: 'GPU VM',
            setupState: 'setting-up',
            setupMethod: 'provisioned',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-create',
        '--project',
        'github:stablyai/orca',
        '--host',
        'runtime:gpu',
        '--setup-id',
        'setup-gpu',
        '--display-name',
        'GPU VM',
        '--state',
        'setting-up',
        '--method',
        'provisioned',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.create', {
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu',
      setupId: 'setup-gpu',
      path: undefined,
      kind: undefined,
      displayName: 'GPU VM',
      worktreeBasePath: undefined,
      gitUsername: undefined,
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })
  })

  it('deletes project host setup metadata through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup_delete', {
        result: {
          project: {
            id: 'github:stablyai/orca',
            displayName: 'Orca',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '/srv/orca',
            displayName: 'GPU VM',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'setup-delete', '--setup', 'setup-gpu', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.delete', {
      setupId: 'setup-gpu'
    })
  })
})
