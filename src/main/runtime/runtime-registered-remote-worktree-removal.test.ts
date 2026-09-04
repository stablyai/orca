import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { removeRuntimeRegisteredRemoteWorktree } from './runtime-registered-remote-worktree-removal'

const getArchiveHooksForRemovalMock = vi.fn()
const runRemoteArchiveHookMock = vi.fn()

vi.mock('../ipc/worktrees/removal/worktree-archive-hook', () => ({
  getArchiveHooksForRemoval: (...args: unknown[]) => getArchiveHooksForRemovalMock(...args),
  runRemoteArchiveHook: (...args: unknown[]) => runRemoteArchiveHookMock(...args)
}))

vi.mock('../ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemoteSsh: vi.fn().mockResolvedValue(undefined)
}))

const TEST_WORKTREE_PATH = '/remote/feature'

function baseArgs() {
  // Why: repo.connectionId left undefined on purpose — the resolved removal route's
  // connectionId is the only correct source, per worktree-removal-execution-host-route.ts.
  const repo = { id: 'repo-1', path: '/remote/repo', displayName: 'repo' } as Repo
  return {
    repo,
    target: { id: 'repo-1::/remote/feature', repoId: 'repo-1', path: TEST_WORKTREE_PATH },
    registeredWorktree: {
      path: TEST_WORKTREE_PATH,
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    },
    removedPushTarget: undefined,
    store: {} as never,
    provider: {
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    } as never,
    connectionId: 'ssh-1',
    force: true,
    allowUnverifiedPtyStop: false,
    deleteBranch: true,
    acquireWatcherRemoval: vi
      .fn()
      .mockResolvedValue({ finish: vi.fn().mockResolvedValue(undefined) }),
    stopPtys: vi.fn().mockResolvedValue(undefined),
    deleteHistory: vi.fn().mockResolvedValue(undefined),
    preserveBranchHead: (result: unknown) => result,
    finishRemoval: vi.fn()
  }
}

describe('removeRuntimeRegisteredRemoteWorktree', () => {
  it('keys the archive hook off the resolved connection id, not repo.connectionId', async () => {
    getArchiveHooksForRemovalMock.mockResolvedValue({ scripts: { archive: 'echo archived' } })
    runRemoteArchiveHookMock.mockResolvedValue({ success: true, output: '' })
    const args = baseArgs()

    await removeRuntimeRegisteredRemoteWorktree({ ...args, runHooks: true } as never)

    expect(getArchiveHooksForRemovalMock).toHaveBeenCalledWith(args.repo, 'ssh-1')
    expect(runRemoteArchiveHookMock).toHaveBeenCalledWith(
      args.repo,
      'ssh-1',
      TEST_WORKTREE_PATH,
      'echo archived'
    )
  })

  it('returns the skipped-hook warning without invoking the archive hook when runHooks is false', async () => {
    getArchiveHooksForRemovalMock.mockResolvedValue({ scripts: { archive: 'echo archived' } })
    const args = baseArgs()

    const result = await removeRuntimeRegisteredRemoteWorktree({
      ...args,
      runHooks: false
    } as never)

    expect(runRemoteArchiveHookMock).not.toHaveBeenCalled()
    expect(result.warning).toBe(
      `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
    )
  })
})
