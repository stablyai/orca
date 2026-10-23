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

import { main } from './index'
import { COMMAND_SPECS } from './specs'
import { okFixture, queueFixtures } from './test-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

const TERMINAL_ROW = {
  handle: 'term_1',
  ptyId: 'pty-1',
  worktreeId: 'repo::/wt',
  worktreePath: '/wt',
  branch: 'main',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  title: 'worker',
  connected: true,
  writable: true,
  lastOutputAt: null,
  preview: '',
  executionHostId: 'local'
}

describe('omittedHostIds selector annotation', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('marks a stale runtime host that no caller can select', async () => {
    // Why: `omittedHostIds` is built from the runtime's own bookkeeping, so it names `runtime:`
    // ids for servers that are no longer paired. An agent looping over the list to complete a
    // partial listing hard-errors on those — 6 of 9 in the recorded QA run.
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-paired', 'm4air')
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [TERMINAL_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: {
          hostIds: ['local'],
          omittedHostIds: ['runtime:env-paired', 'runtime:env-retired']
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.hostScope.omittedHostIds).toEqual([
      'runtime:env-paired',
      'runtime:env-retired'
    ])
    expect(printed.result.hostScope.omittedHostSelectors).toEqual([
      { hostId: 'runtime:env-paired', selector: '--environment m4air' },
      { hostId: 'runtime:env-retired', selector: null }
    ])
  })

  it('says which omitted hosts are not selectable in the human listing', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-paired', 'm4air')
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [TERMINAL_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: {
          hostIds: ['local'],
          omittedHostIds: ['runtime:env-paired', 'runtime:env-retired']
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list'], '/tmp/repo')

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('runtime:env-paired (--environment m4air)')
    expect(printed).toContain('runtime:env-retired (not selectable from this machine)')
  })

  it.each([
    ['terminal', 'list', 'req_terminal_list', { terminals: [TERMINAL_ROW] }],
    ['worktree', 'list', 'req_worktree_list', { worktrees: [] }],
    ['worktree', 'ps', 'req_worktree_ps', { worktrees: [] }]
  ] as const)(
    'only suggests flags that `%s %s` accepts',
    async (group, action, requestId, rows) => {
      // Why: `--host local` / `--host ssh:<id>` were suggested here, and the listing rejected
      // them as unknown flags, breaking the agent loop the annotation exists for (#29901).
      pairRuntimeEnvironment(listEnvironmentsMock, 'env-paired', 'm4air')
      queueFixtures(
        callMock,
        okFixture(requestId, {
          ...rows,
          totalCount: 1,
          truncated: false,
          hostScope: {
            hostIds: [],
            omittedHostIds: ['local', 'runtime:env-paired', 'ssh:box-1']
          }
        })
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main([group, action, '--json'], '/tmp/repo')

      const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(printed.result.hostScope.omittedHostSelectors).toEqual([
        { hostId: 'local', selector: null },
        { hostId: 'runtime:env-paired', selector: '--environment m4air' },
        { hostId: 'ssh:box-1', selector: null }
      ])
      const spec = COMMAND_SPECS.find(
        (candidate) => candidate.path.join(' ') === `${group} ${action}`
      )
      for (const { selector } of printed.result.hostScope.omittedHostSelectors) {
        if (selector) {
          expect(spec?.allowedFlags).toContain(selector.split(' ')[0].replace(/^--/, ''))
        }
      }
      // An SSH host is reached through the answering runtime, so no target lookup is needed.
      expect(callMock).toHaveBeenCalledTimes(1)
    }
  )

  it('says this runtime reaches an omitted local or SSH host in the human listing', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [TERMINAL_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: [], omittedHostIds: ['local', 'ssh:box-1'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list'], '/tmp/repo')

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('local (reached through this runtime; no flag selects it)')
    expect(printed).toContain('ssh:box-1 (reached through this runtime; no flag selects it)')
    expect(printed).not.toContain('--host')
  })

  it('never keeps a host id out of omittedHostIds', async () => {
    // Why: filtering the unreachable ones would shrink what the listing admits it did not cover.
    // The gap is real whether or not this machine can name the host that owns it.
    listEnvironmentsMock.mockReturnValue([])
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: [], omittedHostIds: ['runtime:env-retired'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.hostScope.omittedHostIds).toEqual(['runtime:env-retired'])
  })

  it('costs no extra round trip when nothing was omitted', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [TERMINAL_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: [] }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledTimes(1)
  })
})

describe('worktree listings report their host coverage', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('prints a host column and the scope line for `worktree list`', async () => {
    listEnvironmentsMock.mockReturnValue([])
    queueFixtures(
      callMock,
      okFixture('req_worktree_list', {
        worktrees: [
          {
            id: 'repo-ssh::/remote/wt',
            branch: 'main',
            path: '/remote/wt',
            hostId: 'ssh:box-1',
            displayName: 'remote',
            parentWorktreeId: null,
            childWorktreeIds: [],
            linkedIssue: null,
            comment: ''
          }
        ],
        totalCount: 521,
        truncated: true,
        hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['runtime:env-retired'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'list'], '/tmp/repo')

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('host=ssh:box-1')
    expect(printed).toContain('scope: ssh:box-1')
    expect(printed).toContain('runtime:env-retired (not selectable from this machine)')
    expect(printed).toContain('truncated: showing 1 of 521')
  })

  it('does not claim a scope for `worktree ps` when the host reported none', async () => {
    queueFixtures(
      callMock,
      okFixture('req_worktree_ps', { worktrees: [], totalCount: 0, truncated: false })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'ps'], '/tmp/repo')

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('scope: unverifiable')
  })
})
