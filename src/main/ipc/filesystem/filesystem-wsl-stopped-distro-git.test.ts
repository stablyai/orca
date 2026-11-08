import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  checkIgnoredPathsMock,
  detectConflictOperationMock,
  getBranchCompareMock,
  getBranchDiffMock,
  getDiffMock,
  getStatusMock,
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
const isWslDistroRunningMock = vi.hoisted(() =>
  vi.fn(async (_distro: string, _options?: unknown) => false)
)
vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async (distro: string, options: unknown) =>
    (await isWslDistroRunningMock(distro, options)) ? 'running' : 'stopped'
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

import { registerFilesystemHandlers } from './filesystem'
import { WslDistroStoppedError } from '../../wsl/filesystem/wsl-unc-access-gate'

const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

async function invoke(channel: string, args: unknown): Promise<unknown> {
  return handlers.get(channel)!(null, args)
}

// verify-15b: git status hit the UNC root 0.45 s after a terminate; background Git must not boot it.
describe('background Git for a stopped WSL distro', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    isWslDistroRunningMock.mockReset().mockResolvedValue(false)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerFilesystemHandlers(store as never)
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it.each([
    ['git:status', { worktreePath: UNC_ROOT }],
    ['git:conflictOperation', { worktreePath: UNC_ROOT }],
    ['git:upstreamStatus', { worktreePath: UNC_ROOT }],
    ['git:branchCompare', { worktreePath: UNC_ROOT, baseRef: 'main' }],
    // Status followers: re-read whenever status changes, so each is a background poll.
    ['git:history', { worktreePath: UNC_ROOT, limit: 50 }],
    ['git:submoduleStatus', { worktreePath: UNC_ROOT, submodulePath: 'vendor/lib' }],
    ['git:checkIgnored', { worktreePath: UNC_ROOT, paths: ['dist'] }],
    ['git:findHugeFoldersToIgnore', { worktreePath: UNC_ROOT }],
    ['git:diff', { worktreePath: UNC_ROOT, filePath: 'a.ts', staged: false }],
    [
      'git:branchDiff',
      {
        worktreePath: UNC_ROOT,
        compare: { baseRef: 'main', baseOid: 'b', headOid: 'h', mergeBase: 'm' },
        filePath: 'a.ts'
      }
    ],
    ['git:commitDiff', { worktreePath: UNC_ROOT, commitOid: 'a'.repeat(40), filePath: 'a.ts' }]
  ])('%s refuses before resolving the path or running Git', async (channel, args) => {
    await expect(invoke(channel, args)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(isWslDistroRunningMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
    expect(realpathMock).not.toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(detectConflictOperationMock).not.toHaveBeenCalled()
    expect(getBranchCompareMock).not.toHaveBeenCalled()
    expect(getDiffMock).not.toHaveBeenCalled()
    expect(getBranchDiffMock).not.toHaveBeenCalled()
    expect(checkIgnoredPathsMock).not.toHaveBeenCalled()
  })
})
