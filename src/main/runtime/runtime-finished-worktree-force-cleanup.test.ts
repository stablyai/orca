import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listWorktreesStrictMock,
  removeWorktreeMock,
  assertWorktreeCleanMock,
  runLocalMock,
  settleMock,
  errorIfMock,
  symlinkMock
} = vi.hoisted(() => ({
  listWorktreesStrictMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  assertWorktreeCleanMock: vi.fn(),
  runLocalMock: vi.fn(),
  settleMock: vi.fn(),
  errorIfMock: vi.fn(),
  symlinkMock: vi.fn()
}))

vi.mock('../git/worktree', () => ({
  listWorktreesStrict: listWorktreesStrictMock,
  assertWorktreeCleanForRemoval: assertWorktreeCleanMock,
  removeWorktree: removeWorktreeMock
}))
vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async () => ({ stdout: '', stderr: '' }))
}))
vi.mock('../hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEffectiveHooks: () => null,
    runHook: vi.fn()
  }
})
vi.mock('../git/worktree-shared-directories', () => ({
  getWorktreeSharedLinkPaths: () => []
}))
vi.mock('../ipc/worktree-symlinks', () => ({
  findExistingWorktreeSymlinkPaths: symlinkMock,
  removeWorktreeLinkedPaths: vi.fn()
}))
vi.mock('../ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: vi.fn()
}))
vi.mock('../local-worktree-removal-recovery', () => ({
  recoverLocalWindowsWorktreeRemoval: vi.fn(async () => null)
}))
vi.mock('../worktree-finished-force-cleanup', () => ({
  EMPTY_FINISHED_WORKTREE_FORCE_CLEANUP_PLAN: {
    qualifies: false,
    rootPids: [],
    livePids: []
  },
  runLocalFinishedWorktreeForceCleanup: runLocalMock,
  rewriteUnstoppedPtyErrorForFinishedWorktree: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  settleOrphanedLocalWorktreeDirectory: settleMock,
  errorIfOrphanDirectoryRemains: errorIfMock
}))

import { removeRuntimeRegisteredLocalWorktree } from './runtime-registered-local-worktree-removal'

const registered = {
  path: '/repo-feature',
  head: 'abc',
  branch: 'refs/heads/auto-review',
  isBare: false,
  isMainWorktree: false
}

function removalArgs(
  extra: Partial<Parameters<typeof removeRuntimeRegisteredLocalWorktree>[0]> = {}
): Parameters<typeof removeRuntimeRegisteredLocalWorktree>[0] {
  return {
    repo: { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 },
    target: { id: 'repo-1::/repo-feature', repoId: 'repo-1', path: '/repo-feature' },
    registeredWorktree: registered,
    removedPushTarget: undefined,
    store: { getWorktreeMeta: () => undefined } as never,
    localOptions: {},
    hasLocalOptions: false,
    force: true,
    runHooks: false,
    allowFailedArchiveHook: false,
    allowUnverifiedPtyStop: true,
    deleteBranch: true,
    hasAutomationProvenance: true,
    acquireWatcherRemoval: async () => ({ finish: async () => undefined }),
    stopPtys: vi.fn(async () => undefined),
    closeWatchers: vi.fn(async () => undefined),
    preserveBranchHead: (result) => result ?? {},
    finishRemoval: vi.fn(),
    ...extra
  }
}

describe('runtime finished-worktree force cleanup', () => {
  beforeEach(() => {
    listWorktreesStrictMock.mockReset()
    removeWorktreeMock.mockReset()
    assertWorktreeCleanMock.mockReset()
    runLocalMock.mockReset()
    settleMock.mockReset()
    errorIfMock.mockReset()
    symlinkMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([
      {
        path: '/repo',
        head: 'main',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      registered
    ])
    assertWorktreeCleanMock.mockResolvedValue(undefined)
    symlinkMock.mockResolvedValue([])
    runLocalMock.mockResolvedValue({ qualifies: true, rootPids: [4242], livePids: [] })
    removeWorktreeMock.mockResolvedValue({})
  })

  it('kills the session tree before git worktree remove --force', async () => {
    const stopPtys = vi.fn(async () => undefined)
    const order: string[] = []
    runLocalMock.mockImplementation(async () => {
      order.push('kill')
      return { qualifies: true, rootPids: [4242], livePids: [] }
    })
    stopPtys.mockImplementation(async () => {
      order.push('stop')
    })
    removeWorktreeMock.mockImplementation(async () => {
      order.push('remove')
      return {}
    })

    await removeRuntimeRegisteredLocalWorktree(removalArgs({ stopPtys }))

    expect(order).toEqual(['kill', 'stop', 'remove'])
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/repo',
      '/repo-feature',
      true,
      expect.objectContaining({ knownRemovedWorktree: registered })
    )
  })

  it('keeps workspace metadata when the directory is still present', async () => {
    const finishRemoval = vi.fn()
    removeWorktreeMock.mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: "fatal: '/repo-feature' is not a working tree"
      })
    )
    settleMock.mockResolvedValue('still-present')
    errorIfMock.mockReturnValue(
      new Error('cannot delete because PID 4242 still running in this worktree')
    )

    await expect(
      removeRuntimeRegisteredLocalWorktree(
        removalArgs({ allowUnverifiedPtyStop: false, finishRemoval })
      )
    ).rejects.toThrow('cannot delete because PID 4242 still running in this worktree')

    expect(finishRemoval).not.toHaveBeenCalled()
  })
})
