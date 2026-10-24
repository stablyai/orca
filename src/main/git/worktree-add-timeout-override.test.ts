import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { resolveWorktreeAddTimeoutMs, WORKTREE_ADD_TIMEOUT_MS } from './worktree-operation-options'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('resolveWorktreeAddTimeoutMs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('falls back to the default when the override is unset, blank, or unparseable', () => {
    expect(resolveWorktreeAddTimeoutMs({})).toBe(WORKTREE_ADD_TIMEOUT_MS)
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '   ' })).toBe(
      WORKTREE_ADD_TIMEOUT_MS
    )
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: 'nope' })).toBe(
      WORKTREE_ADD_TIMEOUT_MS
    )
  })

  it('raises the timeout up to the closed maximum', () => {
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300000' })).toBe(300_000)
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300000.9' })).toBe(300_000)
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '999999999' })).toBe(
      1_800_000
    )
  })

  it('treats an infinite override as the maximum, not the default', () => {
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: 'Infinity' })).toBe(
      1_800_000
    )
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '1e400' })).toBe(1_800_000)
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '-Infinity' })).toBe(
      WORKTREE_ADD_TIMEOUT_MS
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"Infinity" is outside [180000, 1800000]ms; using 1800000ms')
    )
  })

  it('stays quiet when the value is unset, blank, or lands in range', () => {
    resolveWorktreeAddTimeoutMs({})
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '   ' })
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '600000' })
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300000.9' })

    expect(warnSpy).not.toHaveBeenCalled()
  })

  // A seconds-versus-milliseconds mistake should warn when clamped.
  it('warns with the range when it clamps an out-of-range value', () => {
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300' })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[git/worktree] ORCA_WORKTREE_ADD_TIMEOUT_MS="300" is outside [180000, 1800000]ms; using 180000ms'
    )
  })

  it('warns that an unparseable value is not a number rather than out of range', () => {
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '600_000' })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"600_000" is not a number; using 180000ms')
    )
  })

  it('never lowers the timeout below the stall-guard default', () => {
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300' })).toBe(
      WORKTREE_ADD_TIMEOUT_MS
    )
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '0' })).toBe(
      WORKTREE_ADD_TIMEOUT_MS
    )
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '-1' })).toBe(
      WORKTREE_ADD_TIMEOUT_MS
    )
  })
})
