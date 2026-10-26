// Bump catalog generation before post-mutation awaits so clients can reject listings from before a create or removal.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isWorktreeCatalogVersion } from '../../shared/worktree/catalog-version'
import { getLocalWorktreeScanGeneration } from '../local-worktree-scan-generation'
import {
  addWorktreeMock,
  listWorktreesMock,
  removeWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { mockKnownFeatureWorktree } from './worktrees-test-fixtures'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

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
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
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
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

// Every await after mutation can admit a listing stamped with the old generation.
type GenerationWitness = { during?: number; after?: number }

function witnessAfter(witness: GenerationWitness, repoId: string): void {
  if (witness.during !== undefined && witness.after === undefined) {
    witness.after = getLocalWorktreeScanGeneration(repoId)
  }
}

function createdRow(path: string, branch: string) {
  return { path, head: 'abc123', branch, isBare: false, isMainWorktree: false }
}

function replySequence(reply: unknown): number | undefined {
  if (typeof reply !== 'object' || reply === null || !('catalogVersion' in reply)) {
    return undefined
  }
  return isWorktreeCatalogVersion(reply.catalogVersion) ? reply.catalogVersion.sequence : undefined
}

describe('worktree mutation scan-generation ordering', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('bumps the generation before the first step after a local git worktree add', async () => {
    const witness: GenerationWitness = {}
    addWorktreeMock.mockImplementation(async () => {
      witness.during = getLocalWorktreeScanGeneration('repo-1')
      return {}
    })
    // Generated-name retirement is the first awaited step after Git add.
    store.addRetiredWorktreeName.mockImplementation(() => witnessAfter(witness, 'repo-1'))
    listWorktreesMock.mockResolvedValue([createdRow('/workspace/nautilus', 'nautilus')])

    const result: unknown = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'nautilus',
      nameWasGenerated: true
    })

    expect(store.addRetiredWorktreeName).toHaveBeenCalledWith('repo-1', 'nautilus')
    expect(witness.after).toBeGreaterThan(witness.during ?? Infinity)
    expect(replySequence(result)).toBeGreaterThanOrEqual(witness.after ?? Infinity)
  })

  it('bumps the generation before the first step after a local git worktree remove', async () => {
    mockKnownFeatureWorktree()
    const witness: GenerationWitness = {}
    removeWorktreeMock.mockImplementation(async () => {
      witness.during = getLocalWorktreeScanGeneration('repo-1')
    })
    // Watcher release is the first awaited step after Git removal.
    runtimeStub.acquireFileWatcherRemoval.mockResolvedValue({
      finish: vi.fn(async () => witnessAfter(witness, 'repo-1'))
    })

    const result: unknown = await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      force: true
    })

    expect(removeWorktreeMock).toHaveBeenCalledOnce()
    expect(witness.after).toBeGreaterThan(witness.during ?? Infinity)
    expect(replySequence(result)).toBeGreaterThanOrEqual(witness.after ?? Infinity)
  })
})
