/* eslint-disable max-lines -- Why: CLI parser tests share one mocked runtime client and fixture queue; splitting this file would duplicate setup and make command coverage harder to audit. */
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn()
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

import {
  buildCurrentWorktreeSelector,
  COMMAND_SPECS,
  main,
  normalizeWorktreeSelector
} from './index'
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
})

describe('orca cli worktree awareness', () => {
  const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
  const originalUserDataPath = process.env.ORCA_USER_DATA_PATH
  const originalPairingCode = process.env.ORCA_PAIRING_CODE
  const originalRemotePairing = process.env.ORCA_REMOTE_PAIRING
  const originalEnvironment = process.env.ORCA_ENVIRONMENT

  beforeEach(() => {
    callMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_USER_DATA_PATH
    serveOrcaAppMock.mockReset()
    getDefaultUserDataPathMock.mockClear()
    addEnvironmentFromPairingCodeMock.mockReset()
    listEnvironmentsMock.mockReset()
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
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
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

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

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
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
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
      parentWorktree: `path:${path.resolve('/tmp/repo/parent')}`,
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
      parentWorktree: undefined,
      noParent: true
    })
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
      cwdParentWorktree: `path:${path.resolve('/tmp/repo')}`,
      noParent: false,
      callerTerminalHandle: undefined
    })
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
      parentWorktree: `path:${path.resolve('/tmp/repo/parent')}`,
      noParent: false,
      callerTerminalHandle: undefined
    })
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
      'Choose either --parent-worktree or --no-parent, not both.'
    )
    expect(process.exitCode).toBe(1)

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
      cwdParentWorktree: `path:${path.resolve('/tmp/repo')}`,
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
      cwdParentWorktree: `path:${path.resolve('/tmp/repo')}`,
      noParent: false,
      callerTerminalHandle: undefined
    })
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
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
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
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
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
    expect(callMock).toHaveBeenCalledWith('browser.tabCurrent', { worktree: undefined })
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

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.create', {
      name: 'Daily review',
      prompt: 'Review open changes',
      agentId: 'codex',
      repo: undefined,
      workspace: `path:${path.resolve('/tmp/repo/feature')}`,
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
      okFixture('req_create', { automation: { id: 'auto-1', name: 'Daily review' } }),
      okFixture('req_edit', { automation: { id: 'auto-1', name: 'Daily review' } })
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

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'automation.create',
      expect.objectContaining({
        workspace: `path:${path.resolve('/tmp/repo/feature')}`,
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
    { flag: 'enabled', value: 'false', message: '--enabled does not take a value' },
    { flag: 'disabled', value: 'false', message: '--disabled does not take a value' }
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
      okFixture('req_automation_create', { automation: { id: 'auto-1', name: 'Daily review' } })
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

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.create', {
      name: 'Daily review',
      prompt: 'Review open changes',
      agentId: 'codex',
      repo: undefined,
      workspace: `path:${path.resolve('/tmp/repo/feature')}`,
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
      okFixture('req_edit', { automation: { id: 'auto-1', name: 'Daily review' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['automations', 'edit', 'auto-1', '--workspace', 'current', '--enabled', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.update', {
      id: 'auto-1',
      updates: {
        name: undefined,
        prompt: undefined,
        agentId: undefined,
        repo: undefined,
        workspace: `path:${path.resolve('/tmp/repo/feature')}`,
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
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.delete', { id: 'auto-1' })
    expect(callMock).toHaveBeenNthCalledWith(3, 'automation.runNow', { id: 'auto-1' })
    expect(callMock).toHaveBeenNthCalledWith(4, 'automation.show', { id: 'auto-1' })
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
})
