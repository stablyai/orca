import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorktreeMock,
  getEffectiveHooksMock,
  listWorktreesMock,
  removeWorktreeMock,
  runHookMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import {
  _resetPendingWorktreeRemovalsForTests,
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
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
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

function remove(args: Record<string, unknown>): Promise<RemoveWorktreeResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktrees:remove resolves a RemoveWorktreeResult.
  return handlers['worktrees:remove'](null, args) as Promise<RemoveWorktreeResult>
}

type ListedRow = { id: string; removing?: true }

async function listRepoRows(): Promise<ListedRow[]> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktrees:list resolves the repo's Worktree rows.
  return (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as ListedRow[]
}

function blockGitRemove(): {
  release: (result?: RemoveWorktreeResult) => void
  fail: (error: Error) => void
} {
  let release!: (result?: RemoveWorktreeResult) => void
  let fail!: (error: Error) => void
  removeWorktreeMock.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        release = (result = {}) => resolve(result)
        fail = reject
      })
  )
  return {
    release: (result) => release(result),
    fail: (error) => fail(error)
  }
}

const featureId = 'repo-1::/workspace/feature-wt'

describe('worktrees:remove in the background', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
  })

  it('replies once Git finishes, listing the row as removing until then', async () => {
    const worktrees = mockKnownFeatureWorktree()
    const git = blockGitRemove()

    const reply = remove({ worktreeId: featureId })
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()

    const during = await listRepoRows()
    expect(during.find((row) => row.id === featureId)?.removing).toBe(true)
    expect(during.find((row) => row.id === 'repo-1::/workspace/repo')?.removing).toBeUndefined()

    listWorktreesMock.mockResolvedValue([worktrees[0]])
    git.release({ preservedBranch: { branchName: 'feature', head: 'feature' } })

    const result = await reply
    expect(result).toMatchObject({ preservedBranch: { branchName: 'feature', head: 'feature' } })
    expect(result.removing).toBeUndefined()
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(featureId, 'local')
    const after = await listRepoRows()
    expect(after.map((row) => row.id)).not.toContain(featureId)
  })

  it('replies with the delete error and lists the row normally again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockKnownFeatureWorktree()
    const git = blockGitRemove()

    const reply = remove({ worktreeId: featureId })
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))
    git.fail(new Error('permission denied'))

    await expect(reply).rejects.toThrow('permission denied')
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    const rows = await listRepoRows()
    expect(rows.find((row) => row.id === featureId)).toBeDefined()
    expect(rows.find((row) => row.id === featureId)?.removing).toBeUndefined()

    // A retry is a fresh removal, not a join onto the failed one.
    removeWorktreeMock.mockResolvedValue({})
    await expect(remove({ worktreeId: featureId })).resolves.not.toHaveProperty('removing')
    expect(removeWorktreeMock).toHaveBeenCalledTimes(2)
  })

  it('joins a repeat delete, with any options, onto the removal Git is running', async () => {
    mockKnownFeatureWorktree()
    const git = blockGitRemove()

    const first = remove({ worktreeId: featureId })
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))
    const repeat = remove({ worktreeId: featureId, force: true, hostId: 'local' })

    git.release({ preservedBranch: { branchName: 'feature', head: 'feature' } })
    const preserved = { preservedBranch: { branchName: 'feature', head: 'feature' } }
    await expect(first).resolves.toMatchObject(preserved)
    await expect(repeat).resolves.toMatchObject(preserved)
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1)
  })

  it('runs same-repo archive hooks one at a time while their Git deletes overlap', async () => {
    const [main, feature] = mockKnownFeatureWorktree()
    const secondId = 'repo-1::/workspace/second-wt'
    listWorktreesMock.mockResolvedValue([
      main,
      feature,
      { ...feature, path: '/workspace/second-wt', branch: 'second', head: 'second' }
    ])
    getEffectiveHooksMock.mockReturnValue({ scripts: { archive: 'git update-ref refs/x HEAD' } })
    const hookReleases: (() => void)[] = []
    runHookMock.mockImplementation(
      () =>
        new Promise((resolve) => hookReleases.push(() => resolve({ success: true, output: '' })))
    )
    const gitReleases: (() => void)[] = []
    removeWorktreeMock.mockImplementation(
      () => new Promise((resolve) => gitReleases.push(() => resolve({})))
    )

    const first = remove({ worktreeId: featureId })
    const second = remove({ worktreeId: secondId })
    await vi.waitFor(() => expect(runHookMock).toHaveBeenCalledTimes(1))
    // Let the second request reach the host's acceptance queue before checking it waits there.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runHookMock).toHaveBeenCalledTimes(1)

    hookReleases[0]?.()
    await vi.waitFor(() => expect(runHookMock).toHaveBeenCalledTimes(2))
    hookReleases[1]?.()
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(2))

    for (const release of gitReleases) {
      release()
    }
    await expect(first).resolves.not.toHaveProperty('removing')
    await expect(second).resolves.not.toHaveProperty('removing')
  })

  it('joins a removal another client got accepted while this request waited its turn', async () => {
    const [main, feature] = mockKnownFeatureWorktree()
    const secondId = 'repo-1::/workspace/second-wt'
    listWorktreesMock.mockResolvedValue([
      main,
      feature,
      { ...feature, path: '/workspace/second-wt', branch: 'second', head: 'second' }
    ])
    getEffectiveHooksMock.mockReturnValue({ scripts: { archive: 'true' } })
    let releaseHook!: () => void
    runHookMock.mockResolvedValue({ success: true, output: '' })
    runHookMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseHook = () => resolve({ success: true, output: '' })
        })
    )
    removeWorktreeMock.mockResolvedValue({})

    const holdsTurn = remove({ worktreeId: secondId })
    await vi.waitFor(() => expect(runHookMock).toHaveBeenCalledTimes(1))
    const queued = remove({ worktreeId: featureId })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Stands in for the runtime path (CLI, paired clients), which coalesces apart from this one.
    let finishOther: ((result: RemoveWorktreeResult) => void) | undefined
    void startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: featureId,
        repoId: 'repo-1',
        repoPath: '/workspace/repo',
        worktree: feature,
        deleteBranch: true,
        force: false
      },
      run: () =>
        new Promise((resolve) => {
          finishOther = resolve
        }),
      publish: () => {}
    })
    releaseHook()
    await holdsTurn
    await vi.waitFor(() => expect(finishOther).toBeDefined())

    const preserved = { preservedBranch: { branchName: 'feature', head: 'feature' } }
    finishOther?.(preserved)
    await expect(queued).resolves.toMatchObject(preserved)
    expect(runHookMock).toHaveBeenCalledTimes(1)
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1)
  })

  it('gives a create with the same name the next free name while the delete runs', async () => {
    mockKnownFeatureWorktree()
    blockGitRemove()
    void remove({ worktreeId: featureId }).catch(() => {})
    await vi.waitFor(() => expect(removeWorktreeMock).toHaveBeenCalledTimes(1))

    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/feature-wt-2',
        head: 'abc',
        branch: 'feature-wt-2',
        isBare: false,
        isMainWorktree: false
      }
    ])
    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'feature-wt' })

    expect(addWorktreeMock).toHaveBeenCalledTimes(1)
    expect(addWorktreeMock.mock.calls[0]?.[1]).toBe('/workspace/feature-wt-2')
  })
})
