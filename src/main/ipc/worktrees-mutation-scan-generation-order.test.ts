// A listing's catalog version is the generation its scan began at, so a create or remove must bump
// that generation before anything after its git mutation can yield. Otherwise a listing that began
// before the mutation and one that began after it share a sequence, and the client cannot refuse
// the older one: it purges a new workspace, or restores a removed one.
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

// Why the first step after the mutation, not the re-list: every await between them is a window in
// which a listing can begin at the old generation yet see the mutation.
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
    // Why a generated name: retiring it is the first awaited step after the add.
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
    // Why the watcher gate: releasing it is the first awaited step after the git removal.
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
