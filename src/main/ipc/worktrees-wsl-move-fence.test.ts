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
import * as issueCommandFile from '../issue-command-file'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

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

  it('refuses a forget before touching metadata', async () => {
    await expect(
      handlers['worktrees:forgetLocal'](null, { worktreeId: MOVING })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
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

  it('refuses an issue-command write before touching the file', async () => {
    const write = vi.spyOn(issueCommandFile, 'writeIssueCommand').mockResolvedValue(undefined)
    await expect(
      handlers['hooks:writeIssueCommand'](null, { repoId: 'repo-1', content: 'run' })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
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
    store.getWorktreeMeta.mockImplementation((id) =>
      id === MOVING ? { sortOrder: 1 } : id === STAYING ? { sortOrder: 2 } : undefined
    )
    await handlers['worktrees:persistSortOrder'](null, { orderedIds: [MOVING, STAYING] })
    expect(store.setWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      hostWorktreeTarget({ id: STAYING, hostId: 'local' }),
      {
        sortOrder: expect.any(Number)
      }
    )
  })
})
