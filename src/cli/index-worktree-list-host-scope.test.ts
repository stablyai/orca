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
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const SSH_WORKTREE_ROW = {
  id: 'repo-ssh::/remote/wt',
  repoId: 'repo-ssh',
  path: '/remote/wt',
  branch: 'main',
  displayName: 'remote',
  isArchived: false,
  isMainWorktree: true,
  linkedIssue: null,
  parentWorktreeId: null,
  childWorktreeIds: [],
  lineage: null,
  hostId: 'ssh:box-1',
  git: { isClean: true, ahead: 0, behind: 0 }
}

describe('orca worktree list host scope', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('keeps the execution host and scope in --json output', async () => {
    queueFixtures(
      callMock,
      okFixture('req_worktree_list', {
        worktrees: [SSH_WORKTREE_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['local'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'list', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.worktrees[0].hostId).toBe('ssh:box-1')
    expect(printed.result.hostScope).toMatchObject({
      hostIds: ['ssh:box-1'],
      omittedHostIds: ['local'],
      omittedHostSelectors: [{ hostId: 'local', selector: '--host local' }]
    })
  })

  it('prints the execution host and scope in human output', async () => {
    queueFixtures(
      callMock,
      okFixture('req_worktree_list', {
        worktrees: [SSH_WORKTREE_ROW],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['local'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'list'], '/tmp/repo')

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('host=ssh:box-1')
    expect(printed).toContain('scope: ssh:box-1')
    expect(printed).toContain('not covered: local')
  })
})

describe('orca worktree ps host scope', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('keeps the execution host and scope in --json output', async () => {
    queueFixtures(
      callMock,
      okFixture('req_worktree_ps', {
        worktrees: [
          {
            worktreeId: SSH_WORKTREE_ROW.id,
            repoId: SSH_WORKTREE_ROW.repoId,
            hostId: 'ssh:box-1',
            repo: 'ssh',
            path: SSH_WORKTREE_ROW.path,
            branch: SSH_WORKTREE_ROW.branch,
            isArchived: false,
            isMainWorktree: true,
            hasHostSidebarActivity: false,
            parentWorktreeId: null,
            childWorktreeIds: [],
            displayName: 'remote',
            workspaceStatus: 'active',
            sortOrder: 0,
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            linkedGitLabMR: null,
            linkedGitLabIssue: null,
            comment: '',
            isPinned: false,
            isActive: false,
            unread: false,
            liveTerminalCount: 0,
            hasAttachedPty: false,
            lastOutputAt: null,
            preview: '',
            status: 'inactive',
            agents: []
          }
        ],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['local'] }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'ps', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.worktrees[0].hostId).toBe('ssh:box-1')
    expect(printed.result.hostScope).toMatchObject({
      hostIds: ['ssh:box-1'],
      omittedHostIds: ['local'],
      omittedHostSelectors: [{ hostId: 'local', selector: '--host local' }]
    })
  })
})
