import { expect, type Mock } from 'vitest'

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { _resetWorktreeScanCacheForTests } from './worktree'
import { __resetSparseCheckoutStateCacheForTests } from './worktree-sparse-checkout-cache'

export type MockResult = {
  error?: Error
  stdout?: string
  stderr?: string
}

// Sparse detection requires core.sparseCheckout=true as well as a pattern file.
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
    // Missing commondir makes this gitdir its own common dir, allowing the config read.
    if (normalized.endsWith('/commondir')) {
      throw enoent()
    }
    if (normalized.endsWith('/config') || normalized.endsWith('/config.worktree')) {
      return ENABLED_SPARSE_CHECKOUT_CONFIG
    }
    throw enoent()
  })
}

export function resetWorktreeRemovalState(): void {
  clearGitCapabilityStateForTests()
  _resetWorktreeScanCacheForTests()
  __resetSparseCheckoutStateCacheForTests()
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
  mocks.statMock.mockRejectedValue(enoent())
  if (mocks.readFileMock) {
    mocks.readFileMock.mockReset()
    mockSparseCheckoutEnabledConfig(mocks.readFileMock)
  }
  mocks.resolveGitDirMock.mockReset()
  mocks.resolveGitDirMock.mockImplementation(async (worktreePath: string) => `${worktreePath}/.git`)
}
