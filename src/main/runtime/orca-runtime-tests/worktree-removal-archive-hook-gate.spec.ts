// Archive hook failure must preserve the checkout, Git registration, agents and ownership evidence (#19334).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertWorktreeCleanForRemoval,
  deleteWorktreeHistoryDirMock,
  getEffectiveHooks,
  invalidateAuthorizedRootsCacheMock,
  listWorktreesStrict,
  removeWorktree,
  removeWorktreeLinkedPathsMock,
  runHook
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createStaleRuntimeWorktreeStore,
  deferred
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'
import {
  ARCHIVE_HOOK_FAILED_REMOVAL_CODE,
  asArchiveHookRefusal
} from '../../../shared/worktree/archive-hook-removal-gate'
import { runSerializedWorktreeRemovalAcceptance } from '../../worktree-removal-acceptance-queue'
import { startBackgroundWorktreeRemoval } from '../../worktree-background-removal'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'

function withArchiveHook(): void {
  vi.mocked(getEffectiveHooks).mockReturnValue({
    scripts: { archive: 'pnpm worktree:archive' }
  })
}

function expectNothingMutated(removeWorktreeMeta: ReturnType<typeof vi.fn>): void {
  expect(removeWorktree).not.toHaveBeenCalled()
  expect(removeWorktreeMeta).not.toHaveBeenCalled()
  expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
  expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  expect(invalidateAuthorizedRootsCacheMock).not.toHaveBeenCalled()
  // Only the pre-hook lookup runs; hook failure prevents post-hook refresh and preflights.
  expect(listWorktreesStrict).toHaveBeenCalledTimes(1)
  expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
}

describe('archive hook removal gate', () => {
  // Aggregate imports share mocks; clear call counts here and restore defaults afterwards.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
  })

  it('refuses removal and mutates nothing when the archive hook exits 23', async () => {
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    withArchiveHook()
    vi.mocked(runHook).mockResolvedValue({
      success: false,
      output: 'backup target unreachable',
      exitCode: 23
    })

    const failure = await runtime
      .removeManagedWorktree(TEST_WORKTREE_ID, { force: false, runHooks: true })
      .catch((error: unknown) => error)

    const refusal = asArchiveHookRefusal(failure)
    expect(refusal.code).toBe(ARCHIVE_HOOK_FAILED_REMOVAL_CODE)
    expect(refusal.data).toEqual({
      worktreePath: TEST_WORKTREE_PATH,
      outcome: 'exited',
      exitCode: 23,
      output: 'backup target unreachable'
    })
    expectNothingMutated(removeWorktreeMeta)
  })

  it('refuses removal when the hook never reported an exit, without claiming it passed', async () => {
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    withArchiveHook()
    // Timeout or host loss is unverifiable, never a successful hook.
    vi.mocked(runHook).mockResolvedValue({
      success: false,
      output: 'Hook timed out after 120000ms.'
    })

    const failure = await runtime
      .removeManagedWorktree(TEST_WORKTREE_ID, { force: false, runHooks: true })
      .catch((error: unknown) => error)

    const refusal = asArchiveHookRefusal(failure)
    expect(refusal.data).toEqual({
      worktreePath: TEST_WORKTREE_PATH,
      outcome: 'unverifiable',
      output: 'Hook timed out after 120000ms.'
    })
    expectNothingMutated(removeWorktreeMeta)
  })

  it('does not let --force waive a failed archive hook', async () => {
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    withArchiveHook()
    vi.mocked(runHook).mockResolvedValue({
      success: false,
      output: 'boom',
      exitCode: 23
    })

    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
        force: true,
        runHooks: true,
        allowUnverifiedPtyStop: true
      })
    ).rejects.toMatchObject({ code: ARCHIVE_HOOK_FAILED_REMOVAL_CODE })
    expectNothingMutated(removeWorktreeMeta)
  })

  it('removes and records the waiver when the failure is explicitly overridden', async () => {
    const runtime = createWorktreeRemovalRuntime()
    withArchiveHook()
    vi.mocked(runHook).mockResolvedValue({
      success: false,
      output: 'boom',
      exitCode: 23
    })
    vi.mocked(removeWorktree).mockResolvedValue({})

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: false,
      runHooks: true,
      allowUnverifiedPtyStop: false,
      allowFailedArchiveHook: true
    })

    expect(result.archiveHookOverride).toEqual({
      worktreePath: TEST_WORKTREE_PATH,
      outcome: 'exited',
      exitCode: 23,
      output: 'boom',
      overridden: true
    })
    expect(removeWorktree).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      TEST_WORKTREE_PATH,
      false,
      expect.objectContaining({
        knownRemovedWorktree: expect.objectContaining({
          path: TEST_WORKTREE_PATH
        })
      })
    )
  })

  it('removes without an override record when the hook succeeds', async () => {
    const runtime = createWorktreeRemovalRuntime()
    withArchiveHook()
    vi.mocked(runHook).mockResolvedValue({
      success: true,
      output: '',
      exitCode: 0
    })
    vi.mocked(removeWorktree).mockResolvedValue({})

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: false,
      runHooks: true
    })

    expect(result.archiveHookOverride).toBeUndefined()
    expect(removeWorktree).toHaveBeenCalled()
  })

  it('removes when the hook is configured but not requested', async () => {
    const runtime = createWorktreeRemovalRuntime()
    withArchiveHook()
    vi.mocked(removeWorktree).mockResolvedValue({})

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(runHook).not.toHaveBeenCalled()
    expect(result.warning).toContain('archive hook skipped')
    expect(removeWorktree).toHaveBeenCalled()
  })

  it('removes when no archive hook is configured', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(removeWorktree).mockResolvedValue({})

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: false,
      runHooks: true
    })

    expect(runHook).not.toHaveBeenCalled()
    expect(result.warning).toBeUndefined()
    expect(removeWorktree).toHaveBeenCalled()
  })

  it('holds a desktop removal in the same repo until this one is accepted', async () => {
    const runtime = createWorktreeRemovalRuntime()
    withArchiveHook()
    const hookRun = deferred<{ success: boolean; output: string; exitCode?: number }>()
    vi.mocked(runHook).mockReturnValue(hookRun.promise)
    vi.mocked(removeWorktree).mockResolvedValue({})

    const removal = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: false,
      runHooks: true
    })
    await vi.waitFor(() => expect(runHook).toHaveBeenCalled())
    // The desktop IPC path queues its acceptance on this same per-repo queue.
    const sibling = vi.fn(async () => {})
    const siblingAccepted = runSerializedWorktreeRemovalAcceptance(TEST_REPO_PATH, sibling)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sibling).not.toHaveBeenCalled()

    hookRun.resolve({ success: true, output: '', exitCode: 0 })
    await siblingAccepted
    expect(sibling).toHaveBeenCalledTimes(1)
    await expect(removal).resolves.toEqual({})
  })

  it('joins a desktop removal of the same worktree accepted while this one waited', async () => {
    const runtime = createWorktreeRemovalRuntime()
    withArchiveHook()
    vi.mocked(runHook).mockResolvedValue({ success: true, output: '' })
    vi.mocked(removeWorktree).mockResolvedValue({})
    const siblingTurn = deferred<void>()
    void runSerializedWorktreeRemovalAcceptance(TEST_REPO_PATH, () => siblingTurn.promise)

    const removal = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: false,
      runHooks: true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The desktop IPC path coalesces apart from this one; stand in for its accepted removal.
    const desktopDelete = deferred<RemoveWorktreeResult>()
    void startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: TEST_WORKTREE_ID,
        repoId: 'repo-1',
        repoPath: TEST_REPO_PATH,
        worktree: { path: TEST_WORKTREE_PATH, branch: 'feature', head: 'feature' },
        deleteBranch: true,
        force: false
      },
      run: () => desktopDelete.promise,
      publish: () => {}
    })
    siblingTurn.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const preserved = { preservedBranch: { branchName: 'feature', head: 'feature' } }
    desktopDelete.resolve(preserved)

    await expect(removal).resolves.toMatchObject(preserved)
    expect(runHook).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('does not coalesce an override retry onto the refusal already in flight', async () => {
    const runtime = createWorktreeRemovalRuntime()
    withArchiveHook()
    const hookRun = deferred<{
      success: boolean
      output: string
      exitCode?: number
    }>()
    vi.mocked(runHook).mockReturnValue(hookRun.promise)
    vi.mocked(removeWorktree).mockResolvedValue({})

    const refused = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: false,
      runHooks: true
    })
    await vi.waitFor(() => expect(runHook).toHaveBeenCalled())

    // A concurrent waiver changes the options key and must not join an attempt about to reject the hook.
    await expect(
      runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
        force: false,
        runHooks: true,
        allowUnverifiedPtyStop: false,
        allowFailedArchiveHook: true
      })
    ).rejects.toThrow('Worktree deletion already in progress')

    hookRun.resolve({ success: false, output: 'boom', exitCode: 23 })
    await expect(refused).rejects.toMatchObject({
      code: ARCHIVE_HOOK_FAILED_REMOVAL_CODE
    })
  })
})
