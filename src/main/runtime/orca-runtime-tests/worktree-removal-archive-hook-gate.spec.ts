// Regression cover for #19334: a failed archive hook used to be logged and stepped over, so the
// checkout was deleted with nothing archived. The hook is a blocking precondition now.
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
import { ARCHIVE_HOOK_FAILED_REMOVAL_CODE } from '../../../shared/worktree/archive-hook-removal-gate'

function withArchiveHook(): void {
  vi.mocked(getEffectiveHooks).mockReturnValue({
    scripts: { archive: 'pnpm worktree:archive' }
  })
}

function expectNothingMutated(removeWorktreeMeta: ReturnType<typeof vi.fn>): void {
  // The checkout, its Git registration, its agents and Orca's ownership evidence all survive.
  expect(removeWorktree).not.toHaveBeenCalled()
  expect(removeWorktreeMeta).not.toHaveBeenCalled()
  expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
  expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  expect(invalidateAuthorizedRootsCacheMock).not.toHaveBeenCalled()
  // The gate runs before the registration re-read, so even the preflights never start. The one
  // listing is the orchestrator's own lookup ahead of the hook; the post-hook refresh never runs.
  expect(listWorktreesStrict).toHaveBeenCalledTimes(1)
  expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
}

describe('archive hook removal gate', () => {
  // These specs are imported into one aggregate test file, so the module-level mocks arrive with
  // calls from earlier specs. Clear counts here and restore the shared defaults afterwards.
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

    expect(failure).toBeInstanceOf(Error)
    expect((failure as { code?: string }).code).toBe(ARCHIVE_HOOK_FAILED_REMOVAL_CODE)
    expect((failure as { data?: unknown }).data).toEqual({
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
    // A timeout or a lost execution host yields no exit code: `unverifiable`, never a pass.
    vi.mocked(runHook).mockResolvedValue({
      success: false,
      output: 'Hook timed out after 120000ms.'
    })

    const failure = await runtime
      .removeManagedWorktree(TEST_WORKTREE_ID, { force: false, runHooks: true })
      .catch((error: unknown) => error)

    expect((failure as { data?: { outcome?: string; exitCode?: number } }).data).toEqual({
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
      // force + the PTY-stop waiver, i.e. everything the desktop Force Delete sets.
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

    // The waiver is part of the in-flight options key, so a concurrent waived retry is refused
    // outright rather than handed the in-flight attempt that is about to reject on the hook.
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
