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

  it('resolves an omitted SSH host against the targets the runtime actually knows', async () => {
    listEnvironmentsMock.mockReturnValue([])
    queueFixtures(
      callMock,
      okFixture('req_terminal_list', {
        terminals: [TERMINAL_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box-1', 'ssh:box-gone'] }
      }),
      okFixture('req_ssh_targets', { targets: [{ id: 'box-1', label: 'openclaw' }] })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.hostScope.omittedHostSelectors).toEqual([
      { hostId: 'ssh:box-1', selector: '--host ssh:box-1' },
      { hostId: 'ssh:box-gone', selector: null }
    ])
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
