import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeCopiedPaths } from './worktree-symlinks'

// Tiny injectable budgets exercise refusals without gigabyte fixtures.
const TINY_BYTE_BUDGET = { maxBytes: 64, maxEntries: 10_000 }
const TINY_ENTRY_BUDGET = { maxBytes: 1024 * 1024 * 1024, maxEntries: 3 }

describe('createWorktreeCopiedPaths copy budget', () => {
  let root: string
  let primary: string
  let worktree: string
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-copy-budget-paths-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses an over-budget directory before writing anything into the worktree', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'pkg.js'), 'x'.repeat(200))

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['node_modules'], {
      platform: 'linux',
      copyBudget: TINY_BYTE_BUDGET
    })

    expect(skipped).toEqual([{ path: 'node_modules', reason: 'bytes' }])
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
  })

  it('refuses an entry that busts the file-count limit', async () => {
    mkdirSync(join(primary, '.cache'))
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      writeFileSync(join(primary, '.cache', name), '')
    }

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['.cache'], {
      platform: 'linux',
      copyBudget: TINY_ENTRY_BUDGET
    })

    expect(skipped).toEqual([{ path: '.cache', reason: 'entries' }])
    expect(existsSync(join(worktree, '.cache'))).toBe(false)
  })

  it('still copies the entries that fit alongside one that does not', async () => {
    writeFileSync(join(primary, '.env'), 'A=1\n')
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'pkg.js'), 'x'.repeat(200))

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['node_modules', '.env'], {
      platform: 'linux',
      copyBudget: TINY_BYTE_BUDGET
    })

    expect(skipped).toEqual([{ path: 'node_modules', reason: 'bytes' }])
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('A=1\n')
  })

  it('does not fall back to a real copy when a failed clone would escape the byte budget', async () => {
    mkdirSync(join(primary, 'models'))
    writeFileSync(join(primary, 'models', 'checkpoint'), 'x'.repeat(500))
    // The clone was predicted (so bytes went uncharged) but fails mid-copy.
    const cloneWorktreePath = vi.fn(async () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['models'], {
      platform: 'darwin',
      cloneWorktreePath,
      copyBudget: TINY_BYTE_BUDGET
    })

    expect(cloneWorktreePath).toHaveBeenCalledTimes(1)
    expect(skipped).toEqual([{ path: 'models', reason: 'bytes', mayBePartial: true }])
    expect(existsSync(join(worktree, 'models'))).toBe(false)
  })

  it('still copies when the clone was never predicted, so its bytes were already charged', async () => {
    // Double-charging this fixture exceeds the byte cap, exposing missing clone-fallback short-circuiting.
    writeFileSync(join(primary, '.env'), 'x'.repeat(40))
    // Probe timeout predicts a real copy, so fallback must not bill its bytes twice.
    const apfsCloneDeps = {
      execFileAsync: async () => {
        throw new Error('diskutil unavailable')
      },
      randomUUID: () => 'test'
    }

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['.env'], {
      platform: 'darwin',
      apfsCloneDeps,
      copyBudget: TINY_BYTE_BUDGET
    })

    expect(skipped).toEqual([])
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('x'.repeat(40))
  })

  it('bills a recovered clone fallback so a later entry sees the spent budget', async () => {
    writeFileSync(join(primary, 'one'), 'x'.repeat(50))
    writeFileSync(join(primary, 'two'), 'x'.repeat(50))
    // Failed clones must charge real-copy bytes; only the first fits the remaining budget.
    const cloneWorktreePath = vi.fn(async () => {
      throw new Error('clonefile failed')
    })

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['one', 'two'], {
      platform: 'darwin',
      cloneWorktreePath,
      copyBudget: TINY_BYTE_BUDGET
    })

    expect(readFileSync(join(worktree, 'one'), 'utf8')).toBe('x'.repeat(50))
    // File clones publish via link from a temp path; failed publication leaves no partial target.
    expect(skipped).toEqual([{ path: 'two', reason: 'bytes' }])
    expect(existsSync(join(worktree, 'two'))).toBe(false)
  })
})
