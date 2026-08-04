import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorktreeCopyBudgetTracker,
  formatWorktreeIncludeCopyWarning
} from './worktree-include-copy-budget'
import { createWorktreeCopiedPaths, createWorktreeLinkedPaths } from './worktree-symlinks'

const posixIt = process.platform === 'win32' ? it.skip : it

// A byte budget small enough to trip on a fixture that stays trivial on disk —
// the bound must be injectable or testing it would mean writing gigabytes.
const TINY_BYTE_BUDGET = { maxBytes: 64, maxEntries: 10_000 }
const TINY_ENTRY_BUDGET = { maxBytes: 1024 * 1024 * 1024, maxEntries: 3 }

describe('worktree copy budget tracker', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-copy-budget-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('admits a source that fits and reports its measured size', async () => {
    writeFileSync(join(root, 'small.env'), 'A=1\n')
    const tracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)

    await expect(tracker.admit(join(root, 'small.env'))).resolves.toEqual({
      withinBudget: true,
      bytes: 4,
      entries: 1
    })
  })

  it('refuses a directory whose total bytes exceed the budget', async () => {
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'a'), 'x'.repeat(40))
    writeFileSync(join(root, 'node_modules', 'b'), 'x'.repeat(40))
    const tracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)

    await expect(tracker.admit(join(root, 'node_modules'))).resolves.toEqual({
      withinBudget: false,
      reason: 'bytes'
    })
  })

  it('refuses a directory with too many entries even when it weighs nothing', async () => {
    mkdirSync(join(root, 'cache'))
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      writeFileSync(join(root, 'cache', name), '')
    }
    const tracker = createWorktreeCopyBudgetTracker(TINY_ENTRY_BUDGET)

    await expect(tracker.admit(join(root, 'cache'))).resolves.toEqual({
      withinBudget: false,
      reason: 'entries'
    })
  })

  it('spends one budget across every admitted source', async () => {
    writeFileSync(join(root, 'first'), 'x'.repeat(40))
    writeFileSync(join(root, 'second'), 'x'.repeat(40))
    const tracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)

    await expect(tracker.admit(join(root, 'first'))).resolves.toMatchObject({ withinBudget: true })
    await expect(tracker.admit(join(root, 'second'))).resolves.toEqual({
      withinBudget: false,
      reason: 'bytes'
    })
  })

  it('does not spend budget on a refused source, so a later small one still fits', async () => {
    writeFileSync(join(root, 'big'), 'x'.repeat(200))
    writeFileSync(join(root, 'small'), 'A=1\n')
    const tracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)

    await expect(tracker.admit(join(root, 'big'))).resolves.toEqual({
      withinBudget: false,
      reason: 'bytes'
    })
    await expect(tracker.admit(join(root, 'small'))).resolves.toMatchObject({ withinBudget: true })
  })

  it('ignores the byte limit when the backend copies on write, but still counts entries', async () => {
    writeFileSync(join(root, 'huge'), 'x'.repeat(400))
    const tracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)

    await expect(
      tracker.admit(join(root, 'huge'), { bytesAreCopied: false })
    ).resolves.toMatchObject({ withinBudget: true })

    // The same source is refused once its bytes actually have to be written.
    const byteTracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)
    await expect(byteTracker.admit(join(root, 'huge'))).resolves.toEqual({
      withinBudget: false,
      reason: 'bytes'
    })
  })

  it('charges the walk itself so repeated over-budget sources cannot re-walk forever', async () => {
    // 10 sources of 2 entries each, against a walk ceiling of maxEntries * 5.
    for (let index = 0; index < 10; index += 1) {
      mkdirSync(join(root, `dir-${index}`))
      writeFileSync(join(root, `dir-${index}`, 'one'), 'x'.repeat(200))
    }
    writeFileSync(join(root, 'tiny'), '')
    const tracker = createWorktreeCopyBudgetTracker({ maxBytes: 64, maxEntries: 4 })

    for (let index = 0; index < 10; index += 1) {
      await expect(tracker.admit(join(root, `dir-${index}`))).resolves.toMatchObject({
        withinBudget: false
      })
    }

    // Nothing was admitted, so the copy budget itself is untouched and `tiny`
    // would fit — it is refused purely because the walk ceiling is spent, and
    // says so rather than blaming limits it never approached.
    await expect(tracker.admit(join(root, 'tiny'))).resolves.toEqual({
      withinBudget: false,
      reason: 'sizing'
    })
  })

  it('blames the walk ceiling, not the file limit, for an entry that would have fit', async () => {
    // 9 sources of 2 entries each leave 2 of the 20-entry walk ceiling — enough
    // to start measuring `fits`, not enough to finish — while the 4-entry copy
    // budget stays completely unspent.
    for (let index = 0; index < 9; index += 1) {
      mkdirSync(join(root, `dir-${index}`))
      writeFileSync(join(root, `dir-${index}`, 'one'), 'x'.repeat(200))
    }
    mkdirSync(join(root, 'fits'))
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(join(root, 'fits', name), '')
    }
    const tracker = createWorktreeCopyBudgetTracker({ maxBytes: 64, maxEntries: 4 })

    for (let index = 0; index < 9; index += 1) {
      await tracker.admit(join(root, `dir-${index}`))
    }

    // `fits` is 4 entries against an untouched 4-entry budget — the only thing
    // refusing it is the spent walk, so it must not be told it busted a limit.
    await expect(tracker.admit(join(root, 'fits'))).resolves.toEqual({
      withinBudget: false,
      reason: 'sizing'
    })
  })

  it('lets a small entry through after one huge entry is refused on file count', async () => {
    // The regression this guards: sizing `node_modules` burns maxEntries + 1
    // walk, which without headroom would starve every entry listed after it.
    mkdirSync(join(root, 'node_modules'))
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(root, 'node_modules', `pkg-${index}`), '')
    }
    writeFileSync(join(root, '.env'), 'A=1\n')
    const tracker = createWorktreeCopyBudgetTracker({ maxBytes: 1024, maxEntries: 4 })

    await expect(tracker.admit(join(root, 'node_modules'))).resolves.toEqual({
      withinBudget: false,
      reason: 'entries'
    })
    await expect(tracker.admit(join(root, '.env'))).resolves.toMatchObject({ withinBudget: true })
  })

  posixIt('counts a nested symlink without following it', async () => {
    mkdirSync(join(root, 'payload'))
    writeFileSync(join(root, 'payload', 'real'), 'x'.repeat(40))
    mkdirSync(join(root, 'dir'))
    // Following this would re-count `payload` and blow the byte budget.
    symlinkSync(join(root, 'payload'), join(root, 'dir', 'alias'))
    const tracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)

    await expect(tracker.admit(join(root, 'dir'))).resolves.toMatchObject({ withinBudget: true })
  })
})

describe('formatWorktreeIncludeCopyWarning', () => {
  it('is undefined when nothing was skipped', () => {
    expect(formatWorktreeIncludeCopyWarning([])).toBeUndefined()
  })

  it('names every skipped entry so the omission is not silent', () => {
    const warning = formatWorktreeIncludeCopyWarning([
      { path: 'node_modules', reason: 'bytes' },
      { path: '.cache', reason: 'entries' }
    ])

    expect(warning).toContain('"node_modules"')
    expect(warning).toContain('".cache"')
    expect(warning).toContain('.worktreeinclude')
  })

  it('warns that an interrupted copy may have left leftovers behind', () => {
    const warning = formatWorktreeIncludeCopyWarning([
      { path: 'models', reason: 'bytes', mayBePartial: true }
    ])

    expect(warning).toContain('"models" may hold a partial copy')
    expect(warning).toContain('check it before reusing this workspace')
  })

  it('caps the partial-copy list too, so it cannot grow unbounded either', () => {
    const warning = formatWorktreeIncludeCopyWarning(
      Array.from({ length: 10 }, (_, index) => ({
        path: `dir-${index}`,
        reason: 'bytes' as const,
        mayBePartial: true
      }))
    )

    expect(warning).toContain('"dir-4" and 5 more may hold a partial copy')
    expect(warning).not.toContain('"dir-5"')
  })

  it('caps how many entries it names so the warning cannot grow unbounded', () => {
    const warning = formatWorktreeIncludeCopyWarning(
      Array.from({ length: 30 }, (_, index) => ({
        path: `dir-${index}`,
        reason: 'bytes' as const
      }))
    )

    expect(warning).toContain('"dir-0"')
    expect(warning).toContain('and 25 more')
    expect(warning).not.toContain('"dir-6"')
  })

  it('reads grammatically for a single skipped entry', () => {
    const warning = formatWorktreeIncludeCopyWarning([{ path: 'node_modules', reason: 'bytes' }])

    expect(warning).toContain('entry "node_modules" was not copied')
    expect(warning).toContain('copying it would exceed')
    expect(warning).toContain('Copy it in manually if this workspace needs it.')
  })

  it('does not quote the size limits at an entry that was never measured', () => {
    const warning = formatWorktreeIncludeCopyWarning([
      { path: 'node_modules', reason: 'entries' },
      { path: '.env', reason: 'sizing' }
    ])

    expect(warning).toContain('"node_modules"')
    expect(warning).toContain('earlier entries used up the budget for measuring')
    // The limits belong to node_modules' sentence, not to `.env`'s.
    expect(warning).not.toMatch(/"\.env"[^.]*file limit/u)
  })
})

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

  it('copies a normal small include fully and reports nothing skipped', async () => {
    writeFileSync(join(primary, '.env'), 'A=1\n')
    mkdirSync(join(primary, '.vscode'))
    writeFileSync(join(primary, '.vscode', 'settings.json'), '{}')

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['.env', '.vscode'], {
      platform: 'linux'
    })

    expect(skipped).toEqual([])
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('A=1\n')
    expect(readFileSync(join(worktree, '.vscode', 'settings.json'), 'utf8')).toBe('{}')
  })

  it('still clones on macOS when only the byte budget would be exceeded', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'pkg.js'), 'x'.repeat(200))
    const cloneWorktreePath = vi.fn(async () => undefined)

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['node_modules'], {
      platform: 'darwin',
      cloneWorktreePath,
      copyBudget: TINY_BYTE_BUDGET
    })

    // An APFS clone is copy-on-write: bytes cost nothing, so refusing on bytes
    // would deny a copy that is already free.
    expect(skipped).toEqual([])
    expect(cloneWorktreePath).toHaveBeenCalledTimes(1)
  })

  it('does not run the macOS APFS clone for an entry over the file-count limit', async () => {
    mkdirSync(join(primary, '.cache'))
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      writeFileSync(join(primary, '.cache', name), '')
    }
    const cloneWorktreePath = vi.fn(async () => undefined)

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['.cache'], {
      platform: 'darwin',
      cloneWorktreePath,
      copyBudget: TINY_ENTRY_BUDGET
    })

    // Inodes are real work even on the clone path, so the entry limit holds.
    expect(skipped).toEqual([{ path: '.cache', reason: 'entries' }])
    expect(cloneWorktreePath).not.toHaveBeenCalled()
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
    // The whole point: no unbudgeted byte-for-byte copy ran behind the failure.
    expect(existsSync(join(worktree, 'models'))).toBe(false)
  })

  it('still copies when the clone was never predicted, so its bytes were already charged', async () => {
    // Sized so that billing it a second time would bust the 64-byte budget —
    // that is what makes this test notice a missing short-circuit.
    writeFileSync(join(primary, '.env'), 'x'.repeat(40))
    // A wedged df/diskutil makes the volume probe answer "no clone", so bytes
    // are charged up front and the real-copy fallback must simply proceed.
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
    // Clone is predicted for both, then fails, so each falls back to a real
    // copy. The first bills 50 of the 64-byte budget; the second cannot.
    const cloneWorktreePath = vi.fn(async () => {
      throw new Error('clonefile failed')
    })

    const skipped = await createWorktreeCopiedPaths(primary, worktree, ['one', 'two'], {
      platform: 'darwin',
      cloneWorktreePath,
      copyBudget: TINY_BYTE_BUDGET
    })

    expect(readFileSync(join(worktree, 'one'), 'utf8')).toBe('x'.repeat(50))
    // No mayBePartial: a failed *file* clone publishes via link(2) from a temp
    // path, so it never leaves anything at the target to go check.
    expect(skipped).toEqual([{ path: 'two', reason: 'bytes' }])
    expect(existsSync(join(worktree, 'two'))).toBe(false)
  })

  posixIt('leaves link mode unbounded — symlinks cost no bytes', async () => {
    mkdirSync(join(primary, 'node_modules'))
    writeFileSync(join(primary, 'node_modules', 'pkg.js'), 'x'.repeat(200))

    await createWorktreeLinkedPaths(primary, worktree, ['node_modules'], {
      platform: 'linux',
      copyBudget: TINY_BYTE_BUDGET
    })

    expect(existsSync(join(worktree, 'node_modules', 'pkg.js'))).toBe(true)
  })
})
