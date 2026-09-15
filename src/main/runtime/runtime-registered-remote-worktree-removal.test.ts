import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { ArchiveHookRunResult } from '../../shared/worktree/archive-hook-removal-gate'
import { WorktreeArchiveHookFailedError } from '../../shared/worktree/archive-hook-removal-gate'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { removeRuntimeRegisteredRemoteWorktree } from './runtime-registered-remote-worktree-removal'

const {
  cleanupUnusedWorktreePushTargetRemoteSshMock,
  getArchiveHooksForRemovalMock,
  runRemoteArchiveHookMock
} = vi.hoisted(() => ({
  cleanupUnusedWorktreePushTargetRemoteSshMock: vi.fn(),
  getArchiveHooksForRemovalMock: vi.fn(),
  runRemoteArchiveHookMock: vi.fn()
}))

vi.mock('../ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemoteSsh: cleanupUnusedWorktreePushTargetRemoteSshMock
}))

vi.mock('../ipc/worktrees/removal/worktree-archive-hook', () => ({
  getArchiveHooksForRemoval: (...args: unknown[]) => getArchiveHooksForRemovalMock(...args),
  runRemoteArchiveHook: (...args: unknown[]) => runRemoteArchiveHookMock(...args)
}))

type RemoteRemovalArgs = Parameters<typeof removeRuntimeRegisteredRemoteWorktree>[0]
type ProviderDouble = Pick<SshGitProvider, 'listWorktrees' | 'removeWorktree'>

const REPO_PATH = '/remote/repo'
const WORKTREE_PATH = '/remote/feature'
const CONNECTION_ID = 'ssh-1'
const ARCHIVE_SCRIPT = 'echo archive'

const repo = {
  id: 'repo-1',
  path: REPO_PATH,
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
} satisfies Repo

const registeredWorktree = {
  path: WORKTREE_PATH,
  head: 'head-before',
  branch: 'refs/heads/feature/foo',
  isBare: false,
  isMainWorktree: false
} satisfies GitWorktreeInfo

function freshWorktree(overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    ...registeredWorktree,
    ...overrides
  }
}

function providerFor(worktrees: GitWorktreeInfo[] = [freshWorktree()]): SshGitProvider {
  const provider: ProviderDouble = {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    removeWorktree: vi.fn().mockResolvedValue(undefined)
  }
  return provider as unknown as SshGitProvider
}

function makeArgs(overrides: Partial<RemoteRemovalArgs> = {}): RemoteRemovalArgs {
  const args = {
    repo,
    target: {
      id: `repo-1::${WORKTREE_PATH}`,
      repoId: repo.id,
      path: WORKTREE_PATH
    },
    registeredWorktree,
    removedPushTarget: undefined,
    store: {} as RemoteRemovalArgs['store'],
    provider: providerFor(),
    connectionId: CONNECTION_ID,
    runHooks: true,
    allowFailedArchiveHook: false,
    force: false,
    allowUnverifiedPtyStop: false,
    deleteBranch: true,
    acquireWatcherRemoval: vi.fn().mockResolvedValue({
      finish: vi.fn().mockResolvedValue(undefined)
    }),
    stopPtys: vi.fn().mockResolvedValue(undefined),
    deleteHistory: vi.fn().mockResolvedValue(undefined),
    preserveBranchHead: vi.fn(
      (_result: RemoveWorktreeResult | undefined, fallbackHead: string | undefined) => ({
        preservedBranch: { branchName: 'feature/foo', head: fallbackHead }
      })
    ),
    finishRemoval: vi.fn()
  } satisfies RemoteRemovalArgs

  return { ...args, ...overrides }
}

function configureArchiveHook(result: ArchiveHookRunResult = { success: true, output: '' }): void {
  getArchiveHooksForRemovalMock.mockResolvedValue({ scripts: { archive: ARCHIVE_SCRIPT } })
  runRemoteArchiveHookMock.mockResolvedValue(result)
}

function providerMock(args: RemoteRemovalArgs): ProviderDouble {
  return args.provider as unknown as ProviderDouble
}

function expectNoMutation(args: RemoteRemovalArgs): void {
  expect(args.acquireWatcherRemoval).not.toHaveBeenCalled()
  expect(args.stopPtys).not.toHaveBeenCalled()
  expect(providerMock(args).removeWorktree).not.toHaveBeenCalled()
  expect(args.finishRemoval).not.toHaveBeenCalled()
}

beforeEach(() => {
  cleanupUnusedWorktreePushTargetRemoteSshMock.mockReset().mockResolvedValue(undefined)
  getArchiveHooksForRemovalMock.mockReset().mockResolvedValue(null)
  runRemoteArchiveHookMock.mockReset()
})

describe('removeRuntimeRegisteredRemoteWorktree archive-hook safety', () => {
  it('uses the resolved execution connection for hook lookup and execution when the repo row has no connection', async () => {
    configureArchiveHook()
    const args = makeArgs()

    await expect(removeRuntimeRegisteredRemoteWorktree(args)).resolves.toMatchObject({
      preservedBranch: { head: 'head-before' }
    })

    expect(getArchiveHooksForRemovalMock).toHaveBeenCalledWith(args.repo, CONNECTION_ID)
    expect(runRemoteArchiveHookMock).toHaveBeenCalledWith(
      args.repo,
      CONNECTION_ID,
      WORKTREE_PATH,
      ARCHIVE_SCRIPT
    )
  })

  it('returns the existing skipped-hook warning without executing the configured hook', async () => {
    configureArchiveHook()
    const args = makeArgs({ runHooks: false })

    const result = await removeRuntimeRegisteredRemoteWorktree(args)

    expect(result.warning).toBe(
      `orca.yaml archive hook skipped for ${WORKTREE_PATH}; pass --run-hooks to run it.`
    )
    expect(runRemoteArchiveHookMock).not.toHaveBeenCalled()
  })

  it('refuses an observed non-zero remote archive exit before fresh validation or mutation', async () => {
    configureArchiveHook({ success: false, output: 'archive failed', exitCode: 23 })
    const args = makeArgs()

    const failure = await removeRuntimeRegisteredRemoteWorktree(args).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(WorktreeArchiveHookFailedError)
    expect((failure as WorktreeArchiveHookFailedError).data).toEqual({
      worktreePath: WORKTREE_PATH,
      outcome: 'exited',
      exitCode: 23,
      output: 'archive failed'
    })
    expect(runRemoteArchiveHookMock).toHaveBeenCalledWith(
      args.repo,
      CONNECTION_ID,
      WORKTREE_PATH,
      ARCHIVE_SCRIPT
    )
    expect(providerMock(args).listWorktrees).not.toHaveBeenCalled()
    expectNoMutation(args)
  })

  it('refuses a failure without an observed exit as unverifiable before mutation', async () => {
    configureArchiveHook({ success: false, output: 'connection lost' })
    const args = makeArgs()

    const failure = await removeRuntimeRegisteredRemoteWorktree(args).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(WorktreeArchiveHookFailedError)
    expect((failure as WorktreeArchiveHookFailedError).data).toEqual({
      worktreePath: WORKTREE_PATH,
      outcome: 'unverifiable',
      output: 'connection lost'
    })
    expect(runRemoteArchiveHookMock).toHaveBeenCalled()
    expect(providerMock(args).listWorktrees).not.toHaveBeenCalled()
    expectNoMutation(args)
  })

  it('does not let force waive a failed archive hook', async () => {
    configureArchiveHook({ success: false, output: 'archive failed', exitCode: 9 })
    const args = makeArgs({ force: true })

    const failure = await removeRuntimeRegisteredRemoteWorktree(args).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(WorktreeArchiveHookFailedError)
    expect((failure as WorktreeArchiveHookFailedError).data).toMatchObject({
      outcome: 'exited',
      exitCode: 9
    })
    expect(runRemoteArchiveHookMock).toHaveBeenCalled()
    expectNoMutation(args)
  })

  it('runs a failed hook when explicitly allowed, proceeds, and returns its override', async () => {
    configureArchiveHook({ success: false, output: 'archive failed', exitCode: 7 })
    const args = makeArgs({ allowFailedArchiveHook: true })

    const result = await removeRuntimeRegisteredRemoteWorktree(args)

    expect(runRemoteArchiveHookMock).toHaveBeenCalled()
    expect(result.archiveHookOverride).toEqual({
      worktreePath: WORKTREE_PATH,
      outcome: 'exited',
      exitCode: 7,
      output: 'archive failed',
      overridden: true
    })
    expect(providerMock(args).removeWorktree).toHaveBeenCalled()
  })

  it('revalidates a waived failure and refuses when the registration disappeared', async () => {
    configureArchiveHook({ success: false, output: 'archive failed', exitCode: 7 })
    const args = makeArgs({ allowFailedArchiveHook: true })
    vi.mocked(providerMock(args).listWorktrees).mockResolvedValue([])

    await expect(removeRuntimeRegisteredRemoteWorktree(args)).rejects.toThrow(
      /registration changed during deletion/i
    )

    expect(runRemoteArchiveHookMock).toHaveBeenCalled()
    expect(providerMock(args).listWorktrees).toHaveBeenCalledWith(REPO_PATH)
    expectNoMutation(args)
  })

  it('refuses a fresh locked registration before watcher, PTY, or provider mutation', async () => {
    configureArchiveHook()
    const args = makeArgs()
    vi.mocked(providerMock(args).listWorktrees).mockResolvedValue([
      freshWorktree({ locked: true, lockReason: 'archive script left a lock' })
    ])

    await expect(removeRuntimeRegisteredRemoteWorktree(args)).rejects.toThrow(/locked by Git/i)

    expect(runRemoteArchiveHookMock).toHaveBeenCalled()
    expect(providerMock(args).listWorktrees).toHaveBeenCalledWith(REPO_PATH)
    expectNoMutation(args)
  })

  it('uses the fresh equivalent row for watcher, removal, and branch-head preservation', async () => {
    configureArchiveHook()
    const args = makeArgs()
    const refreshed = freshWorktree({
      path: `/remote/./feature`,
      head: 'head-after-archive'
    })
    vi.mocked(providerMock(args).listWorktrees).mockResolvedValue([refreshed])

    await removeRuntimeRegisteredRemoteWorktree(args)

    expect(args.acquireWatcherRemoval).toHaveBeenCalledWith(refreshed.path, CONNECTION_ID)
    expect(providerMock(args).removeWorktree).toHaveBeenCalledWith(refreshed.path, false)
    expect(args.preserveBranchHead).toHaveBeenCalledWith(undefined, refreshed.head)
  })

  it('does not redirect removal to a different fresh worktree path', async () => {
    configureArchiveHook()
    const args = makeArgs()
    const differentPath = '/remote/other-feature'
    vi.mocked(providerMock(args).listWorktrees).mockResolvedValue([
      freshWorktree({ path: differentPath })
    ])

    await expect(removeRuntimeRegisteredRemoteWorktree(args)).rejects.toThrow(
      /registration changed during deletion/i
    )

    expect(providerMock(args).removeWorktree).not.toHaveBeenCalledWith(
      differentPath,
      expect.anything()
    )
    expectNoMutation(args)
  })

  it('freshly re-lists and revalidates even when no archive hook is configured', async () => {
    const args = makeArgs()
    vi.mocked(providerMock(args).listWorktrees).mockResolvedValue([])

    await expect(removeRuntimeRegisteredRemoteWorktree(args)).rejects.toThrow(
      /registration changed during deletion/i
    )

    expect(getArchiveHooksForRemovalMock).toHaveBeenCalledWith(args.repo, CONNECTION_ID)
    expect(runRemoteArchiveHookMock).not.toHaveBeenCalled()
    expect(providerMock(args).listWorktrees).toHaveBeenCalledWith(REPO_PATH)
    expectNoMutation(args)
  })
})
