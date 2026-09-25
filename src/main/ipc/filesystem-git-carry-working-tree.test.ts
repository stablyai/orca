import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  REPO_PATH,
  WORKTREE_FEATURE_PATH,
  getSshGitProviderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const carryLocalWorkingTreeChangesMock = vi.hoisted(() => vi.fn())

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)
vi.mock('../git/source-control/carry-working-tree-changes', () => ({
  carryLocalWorkingTreeChanges: carryLocalWorkingTreeChangesMock
}))

import { registerFilesystemHandlers } from './filesystem'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from './registered-worktree-roots-cache'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers and the roots cache read only getRepos/getSettings, which the harness store provides.
const handlerStore = store as unknown as Parameters<typeof registerFilesystemHandlers>[0]
const CARRIED = { ok: true, trackedChanges: true, untrackedCopied: 2 }
const UNREGISTERED_PATH = path.resolve('/elsewhere/not-a-worktree')

function carry(args: {
  sourceWorktreePath: string
  targetWorktreePath: string
  connectionId?: string
}): Promise<unknown> {
  const handler = handlers.get('git:carryWorkingTreeChanges')
  if (!handler) {
    throw new Error('git:carryWorkingTreeChanges is not registered')
  }
  return Promise.resolve(handler(null, args))
}

describe('git:carryWorkingTreeChanges', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    carryLocalWorkingTreeChangesMock.mockReset()
    carryLocalWorkingTreeChangesMock.mockResolvedValue(CARRIED)
  })

  it('carries between two registered worktrees on the local host', async () => {
    registerWorktreeRootsForRepo(handlerStore, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    registerFilesystemHandlers(handlerStore)

    await expect(
      carry({ sourceWorktreePath: REPO_PATH, targetWorktreePath: WORKTREE_FEATURE_PATH })
    ).resolves.toEqual(CARRIED)

    expect(carryLocalWorkingTreeChangesMock).toHaveBeenCalledExactlyOnceWith(
      REPO_PATH,
      WORKTREE_FEATURE_PATH,
      { admissionTier: 'interactive' }
    )
  })

  it('refuses an unregistered source before git or the filesystem is touched', async () => {
    registerWorktreeRootsForRepo(handlerStore, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    registerFilesystemHandlers(handlerStore)

    await expect(
      carry({ sourceWorktreePath: UNREGISTERED_PATH, targetWorktreePath: WORKTREE_FEATURE_PATH })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(carryLocalWorkingTreeChangesMock).not.toHaveBeenCalled()
  })

  it('refuses an unregistered target before git or the filesystem is touched', async () => {
    registerWorktreeRootsForRepo(handlerStore, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    registerFilesystemHandlers(handlerStore)

    await expect(
      carry({ sourceWorktreePath: WORKTREE_FEATURE_PATH, targetWorktreePath: UNREGISTERED_PATH })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(carryLocalWorkingTreeChangesMock).not.toHaveBeenCalled()
  })

  it('routes an SSH carry to that connection provider on the remote host', async () => {
    const sshProvider = { carryWorkingTreeChanges: vi.fn().mockResolvedValue(CARRIED) }
    getSshGitProviderMock.mockReturnValue(sshProvider)
    registerFilesystemHandlers(handlerStore)

    await expect(
      carry({
        sourceWorktreePath: '/remote/repo',
        targetWorktreePath: '/remote/repo-fork',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual(CARRIED)

    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-1')
    expect(sshProvider.carryWorkingTreeChanges).toHaveBeenCalledExactlyOnceWith(
      '/remote/repo',
      '/remote/repo-fork'
    )
    expect(carryLocalWorkingTreeChangesMock).not.toHaveBeenCalled()
  })

  it('fails without falling back to local when the SSH provider is gone', async () => {
    registerFilesystemHandlers(handlerStore)

    await expect(
      carry({
        sourceWorktreePath: '/remote/repo',
        targetWorktreePath: '/remote/repo-fork',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('Remote connection dropped')

    expect(carryLocalWorkingTreeChangesMock).not.toHaveBeenCalled()
  })
})
