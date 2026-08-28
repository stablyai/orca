import { expect, type Mock } from 'vitest'

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { _resetWorktreeScanCacheForTests } from './worktree'

export type MockResult = {
  error?: Error
  stdout?: string
  stderr?: string
}

// Why: detectSparseCheckout on main also requires core.sparseCheckout=true in git
// config (not just a non-empty pattern file). Unit tests that assert isSparse must
// present an enabled flag; other paths never reach this read after the pattern-file
// fast-path ENOENT.
const ENABLED_SPARSE_CHECKOUT_CONFIG = '[core]\nsparseCheckout = true\n'

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

/** Routes git calls to canned results keyed by `git <args>`, with `#n` selecting the nth call. */
export function createGitCommandMocker(
  gitExecFileAsyncMock: Mock
): (results: Record<string, MockResult>) => void {
  return (results) => {
    const callCounts = new Map<string, number>()
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      const key = `git ${args.join(' ')}`
      const callCount = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, callCount)
      const lineListKey =
        key === 'git worktree list --porcelain -z' ? 'git worktree list --porcelain' : ''
      const result =
        results[`${key}#${callCount}`] ??
        results[key] ??
        (lineListKey
          ? (results[`${lineListKey}#${callCount}`] ?? results[lineListKey])
          : undefined) ??
        {}

      if (result.error) {
        throw Object.assign(result.error, {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? ''
        })
      }

      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
      }
    })
  }
}

export function createGitCallReader(gitExecFileAsyncMock: Mock): () => string[] {
  return () =>
    (gitExecFileAsyncMock.mock.calls as [string[]][]).map((call) => `git ${call[0].join(' ')}`)
}

export function expectGitCallOrder(calls: string[], beforeCall: string, afterCall: string): void {
  expect(calls.indexOf(beforeCall)).toBeGreaterThanOrEqual(0)
  expect(calls.indexOf(afterCall)).toBeGreaterThan(calls.indexOf(beforeCall))
}

export function mockSparseCheckoutEnabledConfig(readFileMock: Mock): void {
  readFileMock.mockImplementation(async (filePath: string) => {
    const normalized = String(filePath).replaceAll('\\', '/')
    // Why: linked worktrees may point at a common dir; treat missing commondir as
    // "this gitdir is the common dir" so the shared config read still runs.
    if (normalized.endsWith('/commondir')) {
      throw enoent()
    }
    if (normalized.endsWith('/config') || normalized.endsWith('/config.worktree')) {
      return ENABLED_SPARSE_CHECKOUT_CONFIG
    }
    throw enoent()
  })
}

export type WorktreeTrashMocks = {
  moveWorktreeDirectoryToTrashMock: Mock
  restoreWorktreeDirectoryFromTrashMock: Mock
  scheduleWorktreeTrashDeletionMock: Mock
}

/** Per-test reset shared by every worktree suite: caches cleared, trash rename unavailable. */
export function resetWorktreeRemovalState(trashMocks: WorktreeTrashMocks): void {
  clearGitCapabilityStateForTests()
  _resetWorktreeScanCacheForTests()
  // Default: the checkout cannot be renamed aside, so removal deletes it in place.
  trashMocks.moveWorktreeDirectoryToTrashMock.mockReset()
  trashMocks.moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined)
  trashMocks.restoreWorktreeDirectoryFromTrashMock.mockReset()
  trashMocks.restoreWorktreeDirectoryFromTrashMock.mockResolvedValue(true)
  trashMocks.scheduleWorktreeTrashDeletionMock.mockReset()
}

export type WorktreeGitMocks = {
  gitExecFileAsyncMock: Mock
  gitExecFileSyncMock: Mock
  translateWslOutputPathsMock: Mock
  statMock: Mock
  resolveGitDirMock: Mock
  /** Omit to leave the sparse-config reader untouched (suites that never read it). */
  readFileMock?: Mock
}

export function resetWorktreeGitMocks(mocks: WorktreeGitMocks): void {
  mocks.gitExecFileAsyncMock.mockReset()
  mocks.gitExecFileSyncMock.mockReset()
  mocks.translateWslOutputPathsMock.mockReset()
  mocks.translateWslOutputPathsMock.mockImplementation((output: string) => output)
  mocks.statMock.mockReset()
  // Default: no worktree has a sparse-checkout config file. Tests that need
  // sparse detection override this.
  mocks.statMock.mockRejectedValue(enoent())
  if (mocks.readFileMock) {
    mocks.readFileMock.mockReset()
    mockSparseCheckoutEnabledConfig(mocks.readFileMock)
  }
  mocks.resolveGitDirMock.mockReset()
  mocks.resolveGitDirMock.mockImplementation(async (worktreePath: string) => `${worktreePath}/.git`)
}
