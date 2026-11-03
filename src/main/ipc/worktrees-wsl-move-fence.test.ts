import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import { mkdtempSync, rmSync } from 'node:fs'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  WslMoveProjectFencedError,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import {
  addWorktreeMock,
  assertWorktreeCleanForRemovalMock,
  forceDeleteLocalBranchMock,
  gitExecFileAsyncMock,
  killAllProcessesForWorktreeMock,
  listWorktreesMock,
  removeWorktreeMock
} from './worktrees-test-module-mocks'
import { handlers, harnessRepo, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { rememberPreservedBranchCleanupTarget } from './worktrees/removal/preserved-branch-cleanup'

import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
    listWorktreesSharedStrictAllowingTrueEmpty: (await import('./worktrees-test-module-mocks'))
      .listWorktreesMock,
    listWorktreesSharedStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
  }
})

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../../shared/git-worktree-porcelain-parser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseWorktreeList: (await import('./worktrees-test-module-mocks')).parseWorktreeListMock
}))

vi.mock('../git/worktrees/removal/worktree-removal-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertWorktreeCleanForRemoval: (await import('./worktrees-test-module-mocks'))
    .assertWorktreeCleanForRemovalMock
}))

vi.mock('../git/worktrees/creation/worktree-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addWorktree: (await import('./worktrees-test-module-mocks')).addWorktreeMock
}))

vi.mock('../git/worktrees/creation/worktree-sparse-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addSparseWorktree: (await import('./worktrees-test-module-mocks')).addSparseWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeWorktree: (await import('./worktrees-test-module-mocks')).removeWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-branch-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  forceDeleteLocalBranch: (await import('./worktrees-test-module-mocks')).forceDeleteLocalBranchMock
}))
vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
  describeCreatedWorktree: (await import('./worktrees-test-module-mocks'))
    .describeCreatedWorktreeMock
}))
const { getWorktreeRunnerMocks } = vi.hoisted(() => {
  function createWorktreeRunnerMocks() {
    return (async () => (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock())()
  }
  let runner: ReturnType<typeof createWorktreeRunnerMocks> | undefined
  return { getWorktreeRunnerMocks: () => (runner ??= createWorktreeRunnerMocks()) }
})

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: (await getWorktreeRunnerMocks()).gitExecFileAsync
}))

vi.mock('../git/command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: (await getWorktreeRunnerMocks()).gitExecFileSync
}))
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/repo-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBaseRefDefault: (await import('./worktrees-test-module-mocks')).getBaseRefDefaultMock
}))
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

const MOVING = 'repo-1::/workspace/feature-wt'
const STAYING = 'repo-2::/workspace/other-wt'
const KEPT = 'repo-2::/workspace/kept-wt'

let userDataPath: string
beforeEach(() => {
  setupWorktreeHandlers()
  // Unstamped writes resolve ownership through the registered repo.
  store.getRepos.mockReturnValue([harnessRepo, { ...harnessRepo, id: 'repo-2' }])
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-worktree-ipc-'))
  loadWslMoveFence(userDataPath)
  seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('worktree IPC under a WSL move', () => {
  it('refuses a create before any Git work', async () => {
    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'new-feature' })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('refuses a delete before any teardown or Git work', async () => {
    await expect(handlers['worktrees:remove'](null, { worktreeId: MOVING })).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
    expect(assertWorktreeCleanForRemovalMock).not.toHaveBeenCalled()
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('refuses a preserved-branch delete before any Git work', async () => {
    rememberPreservedBranchCleanupTarget(
      MOVING,
      'local',
      { preservedBranch: { branchName: 'feature', head: 'abc123' } },
      undefined,
      undefined
    )
    await expect(
      handlers['worktrees:forceDeletePreservedBranch'](null, {
        worktreeId: MOVING,
        branchName: 'feature',
        expectedHead: 'abc123',
        hostId: 'local'
      })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('drops passive metadata quietly and refuses a user edit', () => {
    const updateMeta = (worktreeId: string, updates: Partial<WorktreeMeta>) =>
      handlers['worktrees:updateMeta'](null, { worktreeId, updates })
    expect(updateMeta(MOVING, { isUnread: false })).toBeNull()
    expect(updateMeta(MOVING, { isUnread: true, lastActivityAt: 1 })).toBeNull()
    expect(() => updateMeta(MOVING, { isUnread: true })).toThrow(WslMoveProjectFencedError)
    expect(() => updateMeta(MOVING, { comment: 'x' })).toThrow(WslMoveProjectFencedError)
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    updateMeta(STAYING, { comment: 'x' })
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: STAYING, hostId: 'local' }),
      { comment: 'x' }
    )
  })

  it('drops the moving worktree from a sort-order batch', async () => {
    // KEPT holds the highest rank, so the save keeps it and re-ranks the two rows placed above it.
    const ranks: Record<string, number> = { [MOVING]: 1, [STAYING]: 2, [KEPT]: 3 }
    store.getWorktreeMeta.mockImplementation((id) =>
      ranks[id] === undefined ? undefined : { sortOrder: ranks[id] }
    )
    await handlers['worktrees:persistSortOrder'](null, { orderedIds: [MOVING, STAYING, KEPT] })
    expect(store.setWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: STAYING, hostId: 'local' }),
      {
        sortOrder: expect.any(Number)
      }
    )
  })
})
