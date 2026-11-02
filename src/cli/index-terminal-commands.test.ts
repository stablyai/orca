import { RuntimeRpcFailureError, type RuntimeRpcFailure } from './runtime/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { main } from './index'
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

  const originalExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
    runtimeClientConstructorMock.mockClear()
  })
  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it.each([
    [
      'passes explicit focus through terminal.create',
      {
        title: 'RUNNER',
        command: undefined,
        flags: ['--focus'],
        expected: { focus: true, presentation: 'focused' }
      }
    ],
    [
      'keeps interactive Codex startup commands backgrounded unless focus is explicit',
      {
        title: 'Codex',
        command: 'codex',
        flags: [],
        expected: { focus: false, rendererBacked: true, activate: false }
      }
    ],
    [
      'keeps explicit focus semantics when forcing Codex through the renderer path',
      {
        title: 'Codex',
        command: 'codex',
        flags: ['--focus'],
        expected: { focus: true, presentation: 'focused', rendererBacked: true, activate: true }
      }
    ],
    [
      'does not force the visible terminal path for explicit Codex exec commands',
      {
        title: 'Codex exec',
        command: 'codex exec summarize',
        flags: [],
        expected: { focus: false }
      }
    ],
    [
      'does not force the visible terminal path for Codex exec commands after global options',
      {
        title: 'Codex exec',
        command: 'codex -m gpt-5 --sandbox workspace-write exec summarize',
        flags: [],
        expected: { focus: false }
      }
    ],
    [
      'does not force the visible terminal path for Codex review commands after long options',
      {
        title: 'Codex review',
        command: 'codex --model=gpt-5 --sandbox=workspace-write review',
        flags: [],
        expected: { focus: false }
      }
    ],
    [
      'does not force the visible terminal path for Codex help commands',
      {
        title: 'Codex help',
        command: 'codex --help',
        flags: [],
        expected: { focus: false }
      }
    ],
    [
      'keeps Codex prompts after global options backgrounded unless focus is explicit',
      {
        title: 'Codex prompt',
        command: 'codex -m gpt-5 "fix the flaky test"',
        flags: [],
        expected: { focus: false, rendererBacked: true, activate: false }
      }
    ],
    [
      'keeps interactive Claude startup commands backgrounded unless focus is explicit',
      {
        title: 'Claude',
        command: 'claude',
        flags: [],
        expected: { focus: false, rendererBacked: true, activate: false }
      }
    ],
    [
      'keeps Claude print commands on the background terminal path',
      {
        title: 'Claude print',
        command: 'claude -p "summarize"',
        flags: [],
        expected: { focus: false }
      }
    ]
  ] as const)('%s', async (_name, { title, command, flags, expected }) => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title
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
        title,
        ...(command === undefined ? [] : ['--command', command]),
        ...flags,
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock.mock.calls).toEqual([
      ['terminal.create', { worktree: 'path:/tmp/repo/feature', command, title, ...expected }]
    ])
    expect(process.exitCode).toBeUndefined()
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
      limit: undefined,
      includeVisualLayouts: false
    })
  })

  it('requests visual layouts only for the human-readable terminal list', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_term', { terminals: [], totalCount: 0, truncated: false })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'active'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'terminal.list',
      expect.objectContaining({ includeVisualLayouts: true })
    )
  })

  it('allows agent JSON clients to request visual layouts explicitly', async () => {
    const visualLayouts = [
      {
        worktreeId: 'repo::/tmp/repo/feature',
        worktreePath: '/tmp/repo/feature',
        root: { type: 'group', groupId: null, activeTabId: null, tabs: [] }
      }
    ]
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_term', {
        terminals: [],
        visualLayouts,
        totalCount: 0,
        truncated: false
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['terminal', 'list', '--worktree', 'active', '--include-visual-layouts', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'terminal.list',
      expect.objectContaining({ includeVisualLayouts: true })
    )
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      result: { visualLayouts }
    })
  })

  it.each(
    [[], ['--pairing-code', 'remote-runtime']].flatMap((remote) =>
      [false, true].map((json) => ({ remote, json }))
    )
  )(
    'prints the host failure through terminal create ($remote, json=$json)',
    async ({ remote, json }) => {
      const failure = {
        id: 'start',
        ok: false,
        error: {
          code: 'agent_session_exited_during_start',
          message:
            'Git Bash reported its limit of 128 open terminals on this PC while starting the terminal. Close some Git Bash terminals and try again.'
        },
        _meta: { runtimeId: 'host' }
      } satisfies RuntimeRpcFailure
      callMock.mockRejectedValueOnce(new RuntimeRpcFailureError(failure))
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
      await main(
        [
          'terminal',
          'create',
          '--worktree',
          'path:/tmp/host/workspace',
          ...remote,
          ...(json ? ['--json'] : [])
        ],
        '/tmp/client'
      )
      expect(callMock).toHaveBeenCalledWith(
        'terminal.create',
        expect.objectContaining({ worktree: 'path:/tmp/host/workspace' })
      )
      if (json) {
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(failure)
        expect(stderr).not.toHaveBeenCalled()
      } else {
        expect(stderr).toHaveBeenCalledExactlyOnceWith(failure.error.message)
        expect(log).not.toHaveBeenCalled()
      }
      expect(process.exitCode).toBe(1)
    }
  )

  it('rejects implicit remote terminal create instead of resolving from client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['terminal', 'create', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/client/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message:
          'Remote terminal create requires --worktree because the client cwd cannot identify a server worktree.'
      }
    })
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects an empty --terminal instead of sending to the active pane', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'send', '--terminal', '', '--text', 'x', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(process.exitCode).toBe(1)
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
})
