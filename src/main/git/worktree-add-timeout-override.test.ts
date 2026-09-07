// resolveWorktreeAddTimeoutMs: ORCA_WORKTREE_ADD_TIMEOUT_MS parsing, clamping, and warnings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  moveWorktreeDirectoryToTrashMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  moveWorktreeDirectoryToTrashMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

// Default: the checkout cannot be renamed aside, so removal deletes it in place.
vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import {
  resolveWorktreeAddTimeoutMs,
  WORKTREE_ADD_TIMEOUT_MAX_MS,
  WORKTREE_ADD_TIMEOUT_MS
} from './worktree'
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

  // Why: pin the literals so a future edit to either bound has to be deliberate.
  it('bounds the override to [180s, 30min]', () => {
    expect(WORKTREE_ADD_TIMEOUT_MS).toBe(180_000)
    expect(WORKTREE_ADD_TIMEOUT_MAX_MS).toBe(1_800_000)
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

  // Why: `=Infinity` is the natural way to say "stop killing my checkout"; collapsing it to the
  // default would hand the operator back the exact failure they set the variable to escape.
  it('treats an infinite override as the maximum, not the default', () => {
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: 'Infinity' })).toBe(
      1_800_000
    )
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '1e400' })).toBe(1_800_000)
    expect(resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '-Infinity' })).toBe(
      WORKTREE_ADD_TIMEOUT_MS
    )
    // Why: `Infinity` is a number that got clamped, so reporting "is not a number" while naming the
    // number it used would misdirect exactly the operator this override exists for.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"Infinity" is outside [180000, 1800000]ms; using 1800000ms')
    )
  })

  // Why: trimming and fractional truncation alter the value but are not operator error.
  it('stays quiet when the value is unset, blank, or lands in range', () => {
    resolveWorktreeAddTimeoutMs({})
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '   ' })
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '600000' })
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300000.9' })

    expect(warnSpy).not.toHaveBeenCalled()
  })

  // Why: the seconds/ms mixup is the whole reason the floor exists — it must not be silent.
  it('warns with the range when it clamps an out-of-range value', () => {
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300' })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    // Why: pin the prefix and variable name too — a warning nobody can grep for is not a diagnostic.
    expect(warnSpy).toHaveBeenCalledWith(
      '[git/worktree] ORCA_WORKTREE_ADD_TIMEOUT_MS="300" is outside [180000, 1800000]ms; using 180000ms'
    )
  })

  // Why: `600_000` copied out of worktree.ts is NaN, not out of range — a range complaint would misdirect.
  it('warns that an unparseable value is not a number rather than out of range', () => {
    resolveWorktreeAddTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '600_000' })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"600_000" is not a number; using 180000ms')
    )
  })

  // Why: `=300` means seconds to most operators; clamping it up keeps every create working instead of failing in 300ms.
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
