import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  dirEntry,
  readdirMock,
  realpathMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const diskPreconditionMock = vi.hoisted(() => ({ writeLocalTextFileWithDiskPrecondition: vi.fn() }))
vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktreeGraph: listWorktreesMock,
    listWorktrees: listWorktreesMock
  }
})

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const { listWorktreesMock } = await import('./filesystem-test-harness')
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesMock
  }
})

vi.mock('./local-disk-write-precondition', () => diskPreconditionMock)
vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
// The distro these UNC fixtures name counts as running, so the boot gate lets the touch through.
vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () => 'running'
}))
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock('node:fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../../wsl/filesystem/wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock('../../git/source-control/commit-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitChanges: (await import('./filesystem-test-harness')).commitChangesMock
}))

vi.mock('../../git/source-control/status-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStatus: (await import('./filesystem-test-harness')).getStatusMock
}))

vi.mock('../../git/source-control/git-conflict-operation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectConflictOperation: (await import('./filesystem-test-harness')).detectConflictOperationMock,
  abortMerge: (await import('./filesystem-test-harness')).abortMergeMock,
  abortRebase: (await import('./filesystem-test-harness')).abortRebaseMock
}))

vi.mock('../../git/source-control/file-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDiff: (await import('./filesystem-test-harness')).getDiffMock
}))

vi.mock('../../git/source-control/branch-compare', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchCompare: (await import('./filesystem-test-harness')).getBranchCompareMock
}))

vi.mock('../../git/source-control/branch-diff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchDiff: (await import('./filesystem-test-harness')).getBranchDiffMock
}))

vi.mock('../../git/source-control/staged-commit-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStagedCommitContext: (await import('./filesystem-test-harness')).getStagedCommitContextMock
}))

vi.mock('../../git/source-control/staging', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageFile: (await import('./filesystem-test-harness')).stageFileMock,
  bulkStageFiles: (await import('./filesystem-test-harness')).bulkStageFilesMock,
  stageWorktreeChanges: (await import('./filesystem-test-harness')).stageWorktreeChangesMock,
  unstageFile: (await import('./filesystem-test-harness')).unstageFileMock,
  bulkUnstageFiles: (await import('./filesystem-test-harness')).bulkUnstageFilesMock
}))

vi.mock('../../git/source-control/discard-changes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bulkDiscardChanges: (await import('./filesystem-test-harness')).bulkDiscardChangesMock,
  discardChanges: (await import('./filesystem-test-harness')).discardChangesMock
}))
vi.mock(
  '../../git/source-control/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)

vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../shared/local-file-access'
import { registerFilesystemHandlers } from './filesystem'
import {
  invalidateAuthorizedRootsCache,
  registerWorktreeRootsForRepo
} from '../worktrees/removal/registered-worktree-roots-cache'

function eperm(syscall: string, target: string): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${target}'`), {
    code: 'EPERM'
  })
}

// Handler UNC authorization needs native Windows path resolution; runs in the Windows package lane.
describe.runIf(process.platform === 'win32')('fs:readDir on a UNC drive-mount project', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
  })

  it('lists the folder through its drive path, since WSL refuses the UNC one', async () => {
    const unc = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'mnt', 'c', 'src', 'app')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors root registration reads.
    registerWorktreeRootsForRepo(store as never, 'repo-1', [unc])
    // WSL 2.7 answers EPERM for every Windows access to a drive mount over UNC.
    realpathMock.mockImplementation(async (target: string) => {
      if (target.startsWith('\\\\')) {
        throw eperm('realpath', target)
      }
      return target
    })
    readdirMock.mockImplementation(async (target: string) => {
      if (target.startsWith('\\\\')) {
        throw eperm('scandir', target)
      }
      return [dirEntry({ name: 'src', directory: true }), dirEntry({ name: 'README.md' })]
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readDir')!(null, { dirPath: unc })).resolves.toEqual([
      { name: 'src', isDirectory: true, isSymlink: false },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ])
    expect(readdirMock).toHaveBeenCalledWith('C:\\src\\app', { withFileTypes: true })
  })

  it('still refuses a junction under the project that lands on another drive or outside it', async () => {
    const unc = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'mnt', 'c', 'src', 'app')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors root registration reads.
    registerWorktreeRootsForRepo(store as never, 'repo-1', [unc])
    const junctions: Record<string, string> = {
      'C:\\src\\app\\other-drive': 'D:\\elsewhere',
      'C:\\src\\app\\outside': 'C:\\Users\\me\\secrets'
    }
    realpathMock.mockImplementation(async (target: string) => {
      if (target.startsWith('\\\\')) {
        throw eperm('realpath', target)
      }
      return junctions[target] ?? target
    })
    readdirMock.mockResolvedValue([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerFilesystemHandlers(store as never)

    for (const name of ['other-drive', 'outside']) {
      await expect(
        handlers.get('fs:readDir')!(null, { dirPath: path.win32.join(unc, name) })
      ).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
    }
    expect(readdirMock).not.toHaveBeenCalled()
  })
})
