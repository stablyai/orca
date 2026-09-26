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
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree --pr', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('passes linkedPR through worktree.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create_pr', {
        worktree: {
          ...buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1'),
          linkedPR: 123
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
        '--pr',
        '123',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      displayName: 'feature',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      linkedPR: 123,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: true,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('passes linkedPR through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_pr', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          linkedPR: 123
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--pr', '123', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      linkedPR: 123,
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('clears linkedPR through worktree.set --pr null', async () => {
    queueFixtures(
      callMock,
      okFixture('req_clear_pr', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          linkedPR: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--pr', 'null', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      linkedPR: null,
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: false
    })
  })
})
