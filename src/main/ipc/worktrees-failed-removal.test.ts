// Desktop IPC for a delete that failed after Git dropped the registration: the leftover stays in
// `worktrees:list` with the error, Delete retries it. Git and the disk are mocked;
// runtime-failed-local-worktree-removal.test.ts runs the real thing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  killAllProcessesForWorktreeMock,
  listWorktreesMock,
  removeWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { Worktree } from '../../shared/worktree/types'
import { finishUnregisteredWorktreeRemoval } from '../git/worktree-removal'
import type * as WorktreeRemovalModule from '../git/worktree-removal'
import type * as WorktreeRemovalTable from '../worktree-removal-table'
import type * as WorktreeRemovalLeftover from '../worktree-removal-leftover'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  retryFailedWorktreeRemoval,
  startBackgroundWorktreeRemoval
} from '../worktree-background-removal'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

vi.mock('../git/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRemovalModule>()),
  finishUnregisteredWorktreeRemoval: vi.fn(async () => ({}))
}))
// The leftover is on disk and is the removed checkout's own (no `.git` left).
vi.mock('../worktree-removal-table', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRemovalTable>()),
  worktreeCheckoutExists: vi.fn(async () => true)
}))
vi.mock('../worktree-removal-leftover', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRemovalLeftover>()),
  isUnregisteredRemovalLeftover: vi.fn(async () => true)
}))

const featureId = 'repo-1::/workspace/feature-wt'
const GIT_ERROR = "error: failed to delete '/workspace/feature-wt': Operation not permitted"

function remove(args: Record<string, unknown>): Promise<RemoveWorktreeResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktrees:remove resolves a RemoveWorktreeResult.
  return handlers['worktrees:remove'](null, args) as Promise<RemoveWorktreeResult>
}

async function listFeature(): Promise<Worktree | undefined> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktrees:list resolves the repo's Worktree rows.
  const rows = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as Worktree[]
  return rows.find((row) => row.id === featureId)
}

/** Git fails partway and drops the registration, as `git worktree remove --force` does. */
async function failAfterGitDroppedIt(): Promise<void> {
  const [main, feature] = mockKnownFeatureWorktree()
  const result = startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: featureId,
      repoId: 'repo-1',
      repoPath: '/workspace/repo',
      worktree: feature,
      deleteBranch: true,
      force: false
    },
    run: async () => {
      listWorktreesMock.mockResolvedValue([main])
      throw new Error(GIT_ERROR)
    },
    publish: () => {}
  })
  await expect(result).rejects.toThrow(GIT_ERROR)
  await _settlePendingWorktreeRemovalsForTests()
}

describe('a failed delete Git no longer registers, over desktop IPC', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setupWorktreeHandlers()
  })

  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
    vi.mocked(finishUnregisteredWorktreeRemoval).mockClear()
  })

  it('stays in the listing with the error instead of vanishing', async () => {
    await failAfterGitDroppedIt()

    const row = await listFeature()
    expect(row).toMatchObject({ path: '/workspace/feature-wt', removalError: GIT_ERROR })
    expect(row?.removing).toBeUndefined()
  })

  it('Delete runs the recorded removal again: teardown, leftover, branch and metadata', async () => {
    await failAfterGitDroppedIt()
    killAllProcessesForWorktreeMock.mockClear()

    await expect(remove({ worktreeId: featureId })).resolves.not.toHaveProperty('removing')

    // Git has no registration to delete by; the leftover goes through Orca's own delete.
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(finishUnregisteredWorktreeRemoval).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      { name: 'feature', head: 'feature' },
      expect.any(Function),
      {}
    )
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(
      featureId,
      expect.objectContaining({ requirePhysicalStop: true })
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(featureId, 'local')
    expect(await listFeature()).toBeUndefined()
  })

  it('keeps the row with the new error when the retry fails again', async () => {
    await failAfterGitDroppedIt()
    vi.mocked(finishUnregisteredWorktreeRemoval).mockRejectedValueOnce(new Error('EPERM again'))

    await expect(remove({ worktreeId: featureId })).rejects.toThrow('EPERM again')
    await _settlePendingWorktreeRemovalsForTests()

    expect(await listFeature()).toMatchObject({ removalError: 'EPERM again' })
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('joins a retry another client started while this Delete listed Git', async () => {
    await failAfterGitDroppedIt()
    const [main] = mockKnownFeatureWorktree()
    listWorktreesMock.mockResolvedValue([main])
    const otherClientsRetry = vi.fn(async () => ({}))
    listWorktreesMock.mockImplementationOnce(async () => {
      // Another client's Delete takes the failed record during this Delete's `git worktree list`.
      void retryFailedWorktreeRemoval(featureId, 'local', () => ({
        run: otherClientsRetry,
        publish: () => {}
      }))
      return [main]
    })

    await expect(remove({ worktreeId: featureId })).resolves.not.toHaveProperty('removing')
    await _settlePendingWorktreeRemovalsForTests()

    expect(otherClientsRetry).toHaveBeenCalledTimes(1)
    // Neither a second retry nor the delete for leftovers without a record ran.
    expect(finishUnregisteredWorktreeRemoval).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })

  it('Delete takes the normal delete once Git registers a checkout at the path again', async () => {
    await failAfterGitDroppedIt()
    // A new checkout at the same path: the recorded choices were for the leftover, not for it.
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({})

    await remove({ worktreeId: featureId, force: false })
    await _settlePendingWorktreeRemovalsForTests()

    expect(finishUnregisteredWorktreeRemoval).not.toHaveBeenCalled()
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      expect.anything()
    )
    listWorktreesMock.mockResolvedValue([mockKnownFeatureWorktree()[0]])
    expect(await listFeature()).toBeUndefined()
  })
})
