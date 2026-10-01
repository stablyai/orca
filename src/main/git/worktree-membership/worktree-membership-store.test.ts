import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Runner from '../runner'
import type * as Wsl from '../../wsl'
import type * as FileValidation from './worktree-membership-file-validation'

const runnerSpy = vi.hoisted(() => {
  const calls: string[][] = []
  return { calls, failWorktreeList: false }
})
vi.mock('../runner', async (importOriginal) => {
  const actual = await importOriginal<typeof Runner>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options: Parameters<typeof actual.gitExecFileAsync>[1]) => {
      runnerSpy.calls.push(args)
      if (runnerSpy.failWorktreeList && args[0] === 'worktree' && args[1] === 'list') {
        return Promise.reject(new Error('fatal: unable to read worktrees'))
      }
      return actual.gitExecFileAsync(args, options)
    }
  }
})

type HeldRead = { entered: () => void; release: Promise<void> }
const validationGate = vi.hoisted(() => {
  const gate: {
    /** Each validation takes the next hold after reading, so it commits what it read before. */
    afterRead: HeldRead[]
    transientFailures: number
  } = { afterRead: [], transientFailures: 0 }
  return gate
})
vi.mock('./worktree-membership-file-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof FileValidation>()
  const { WorktreeRowsNeedGit } = await import('./worktree-membership-file-rows')
  return {
    validateMembershipFromFiles: async (
      input: Parameters<typeof actual.validateMembershipFromFiles>[0]
    ) => {
      if (validationGate.transientFailures > 0) {
        validationGate.transientFailures -= 1
        throw new WorktreeRowsNeedGit('unreadable worktrees dir', true)
      }
      const result = await actual.validateMembershipFromFiles(input)
      const hold = validationGate.afterRead.shift()
      if (hold) {
        hold.entered()
        await hold.release
      }
      return result
    }
  }
})

/** Holds the next validation after it read the admin files, until `release`. */
function holdNextValidation(): { entered: Promise<void>; release: () => void } {
  let entered = (): void => {}
  let release = (): void => {}
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve
  })
  validationGate.afterRead.push({ entered, release: releasePromise })
  return { entered: enteredPromise, release }
}

const wslPaths = vi.hoisted(() => new Set<string>())
vi.mock('../../wsl', async (importOriginal) => {
  const actual = await importOriginal<typeof Wsl>()
  return {
    ...actual,
    parseWslPath: (path: string) =>
      wslPaths.has(path) ? { distro: 'Ubuntu', linuxPath: path } : actual.parseWslPath(path)
  }
})

import { clearGitCapabilityStateForTests } from '../git-capability-state'
import {
  listWorktrees,
  listWorktreesSharedStrict,
  listWorktreesSharedStrictAllowingTrueEmpty,
  _resetWorktreeScanCacheForTests,
  bumpWorktreeScanGeneration
} from '../worktree-scan-cache'
import {
  MEMBERSHIP_FULL_DERIVE_FLOOR_MS,
  MEMBERSHIP_IDLE_DROP_MS,
  MEMBERSHIP_REUSE_WINDOW_MS
} from './worktree-membership-model'
import {
  _getWorktreeMembershipModelForTests,
  _resetWorktreeMembershipModelsForTests,
  isWorktreeMembershipModelBacked,
  markWorktreeMembershipDirty,
  MissingRepoPathError,
  readWorktreeMembership,
  retainWorktreeMembershipModels
} from './worktree-membership-store'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

function worktreeListSpawns(): number {
  return runnerSpy.calls.filter((args) => args[0] === 'worktree' && args[1] === 'list').length
}

async function commitIn(worktreePath: string, name: string): Promise<string> {
  await writeFile(join(worktreePath, `${name}.txt`), `${name}\n`)
  await git(['add', '-A'], worktreePath)
  await git(['commit', '-qm', name], worktreePath)
  return git(['rev-parse', 'HEAD'], worktreePath)
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-membership-store-')))
  repoPath = join(scratchDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'membership@example.invalid'])
  await git(['config', 'user.name', 'Membership'])
  await commitIn(repoPath, 'seed')
  _resetWorktreeMembershipModelsForTests()
  _resetWorktreeScanCacheForTests()
  runnerSpy.calls.length = 0
  runnerSpy.failWorktreeList = false
  validationGate.afterRead.length = 0
  validationGate.transientFailures = 0
  wslPaths.clear()
})

afterEach(async () => {
  vi.restoreAllMocks()
  _resetWorktreeMembershipModelsForTests()
  clearGitCapabilityStateForTests()
  await rm(scratchDir, { recursive: true, force: true })
})

describe('worktree membership model: spawns', () => {
  it('runs no git worktree list after the cold baseline, through a burst of changes', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    await listWorktreesSharedStrictAllowingTrueEmpty(repoPath)
    expect(worktreeListSpawns()).toBe(1)

    // A worktrees:changed burst: Orca's own mutation marks, watcher entry marks, and every reader.
    for (let round = 0; round < 5; round++) {
      const head = await commitIn(linked, `burst-${round}`)
      bumpWorktreeScanGeneration(repoPath)
      markWorktreeMembershipDirty(repoPath)
      const [detected, lenient, strict] = await Promise.all([
        listWorktreesSharedStrictAllowingTrueEmpty(repoPath),
        listWorktrees(repoPath),
        listWorktreesSharedStrict(repoPath)
      ])
      for (const rows of [detected, lenient, strict]) {
        expect(rows.find((row) => row.path === linked)?.head).toBe(head)
      }
    }

    expect(worktreeListSpawns()).toBe(1)
  })

  it('answers a missing repo with one stat and no git', async () => {
    const missing = join(scratchDir, 'deleted-repo')
    await expect(readWorktreeMembership(missing)).rejects.toBeInstanceOf(MissingRepoPathError)
    await expect(listWorktrees(missing)).resolves.toEqual([])
    await expect(listWorktreesSharedStrictAllowingTrueEmpty(missing)).resolves.toEqual([])
    await expect(listWorktreesSharedStrict(missing)).rejects.toBeInstanceOf(MissingRepoPathError)
    expect(runnerSpy.calls).toEqual([])
  })
})

describe('worktree membership model: layouts', () => {
  it('builds no model for a WSL path, even when the caller names no distro', async () => {
    wslPaths.add(repoPath)
    await readWorktreeMembership(repoPath)
    await readWorktreeMembership(repoPath)
    expect(_getWorktreeMembershipModelForTests(repoPath)).toBeUndefined()
    expect(worktreeListSpawns()).toBe(2)
  })
})

describe('worktree membership model: failure contracts', () => {
  it('keeps lenient, strict and true-empty apart for a Git failure', async () => {
    runnerSpy.failWorktreeList = true
    await expect(listWorktrees(repoPath)).resolves.toEqual([])
    await expect(listWorktreesSharedStrict(repoPath)).rejects.toThrow('unable to read worktrees')
    await expect(listWorktreesSharedStrictAllowingTrueEmpty(repoPath)).rejects.toThrow(
      'unable to read worktrees'
    )
    // A failed baseline builds no model, so the next read tries again.
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(false)
  })

  it('answers a folder that is not a Git repo as a true empty', async () => {
    const plain = join(scratchDir, 'plain-folder')
    await mkdir(plain)
    await expect(listWorktrees(plain)).resolves.toEqual([])
    await expect(listWorktreesSharedStrictAllowingTrueEmpty(plain)).resolves.toEqual([])
    await expect(listWorktreesSharedStrict(plain)).rejects.toThrow(/not a git repository/i)
  })

  it('answers a folder Git says is no repository by stat alone until a repository appears', async () => {
    const plain = join(scratchDir, 'plain-folder')
    await mkdir(plain)
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await expect(listWorktreesSharedStrict(plain)).rejects.toThrow(/not a git repository/i)
    const firstListings = worktreeListSpawns()

    for (let round = 0; round < 3; round++) {
      now += MEMBERSHIP_REUSE_WINDOW_MS
      const [lenient, trueEmpty, strict] = await Promise.allSettled([
        listWorktrees(plain),
        listWorktreesSharedStrictAllowingTrueEmpty(plain),
        listWorktreesSharedStrict(plain)
      ])
      expect(lenient).toEqual({ status: 'fulfilled', value: [] })
      expect(trueEmpty).toEqual({ status: 'fulfilled', value: [] })
      expect(strict.status === 'rejected' && String(strict.reason)).toMatch(/not a git repository/i)
    }
    expect(worktreeListSpawns()).toBe(firstListings)

    await git(['init', '-q', '-b', 'main'], plain)
    now += MEMBERSHIP_REUSE_WINDOW_MS
    const { rows } = await readWorktreeMembership(plain)
    expect(rows.map((row) => row.path)).toEqual([plain])
  })
})

describe('worktree membership model: freshness', () => {
  it('reuses a result inside the reuse window, then sees an unreported change by stat', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const before = (await readWorktreeMembership(repoPath)).rows
    const head = await commitIn(linked, 'unreported')

    now += MEMBERSHIP_REUSE_WINDOW_MS - 1
    expect((await readWorktreeMembership(repoPath)).rows).toBe(before)

    now += 1
    const after = (await readWorktreeMembership(repoPath)).rows
    expect(after.find((row) => row.path === linked)?.head).toBe(head)
  })

  it('never reuses a result for a reader that arrives after a mark', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await readWorktreeMembership(repoPath)
    const head = await commitIn(linked, 'concurrent')
    markWorktreeMembershipDirty(repoPath)
    const reads = await Promise.all([
      readWorktreeMembership(repoPath),
      readWorktreeMembership(repoPath),
      readWorktreeMembership(repoPath)
    ])
    for (const { rows } of reads) {
      expect(rows.find((row) => row.path === linked)?.head).toBe(head)
    }
  })

  it('does not lose a change marked while a derivation is running', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    now += MEMBERSHIP_REUSE_WINDOW_MS
    const hold = holdNextValidation()
    const running = readWorktreeMembership(repoPath)
    await hold.entered
    markWorktreeMembershipDirty(repoPath)
    hold.release()
    await running
    expect(model.listingOwed).toBe(true)

    const linked = join(scratchDir, 'late')
    await git(['worktree', 'add', '-q', linked, '-b', 'late'])
    const { rows } = await readWorktreeMembership(repoPath)
    expect(rows.map((row) => row.path)).toContain(linked)
  })

  it('never lets a derivation that predates a mark answer a later reader', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    now += MEMBERSHIP_REUSE_WINDOW_MS
    // A background read has read the admin files; then a create lands and Orca marks it.
    const olderHold = holdNextValidation()
    const older = readWorktreeMembership(repoPath)
    await olderHold.entered
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    markWorktreeMembershipDirty(repoPath)
    // Both queue behind the running derivation and share one that starts after them.
    const afterMark = [readWorktreeMembership(repoPath), readWorktreeMembership(repoPath)]

    olderHold.release()
    expect((await older).rows.map((row) => row.path)).not.toContain(created)
    for (const read of await Promise.all(afterMark)) {
      expect(read.rows.map((row) => row.path)).toContain(created)
    }
  })

  it('keeps a mark that lands while the model is first built', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const coldHold = holdNextValidation()
    const cold = readWorktreeMembership(repoPath)
    await coldHold.entered
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    markWorktreeMembershipDirty(repoPath)
    coldHold.release()
    await cold
    now += 1
    const { rows } = await readWorktreeMembership(repoPath)
    expect(rows.map((row) => row.path)).toContain(created)
  })

  it('adopts file rows after a transient cold failure only through the Git parity check', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    validationGate.transientFailures = 1
    await readWorktreeMembership(repoPath)
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    const coldListings = worktreeListSpawns()

    // Nothing moved: no Git, and no file rows adopted unchecked.
    now += MEMBERSHIP_REUSE_WINDOW_MS
    await readWorktreeMembership(repoPath)
    expect(worktreeListSpawns()).toBe(coldListings)
    expect(model.files).toBeNull()

    const head = await commitIn(linked, 'moved')
    now += MEMBERSHIP_REUSE_WINDOW_MS
    const { rows } = await readWorktreeMembership(repoPath)
    // The listing that ran is the parity baseline the file rows were adopted against.
    expect(worktreeListSpawns()).toBe(coldListings + 1)
    expect(model.files).not.toBeNull()
    expect(rows.find((row) => row.path === linked)?.head).toBe(head)
  })

  it('reads a repo whose files keep failing with Git only when its stats move', async () => {
    // HEAD names `ghost` while `ghost/child` exists: reading that ref hits a directory (EISDIR),
    // an error no retry cures, though Git lists the worktree fine.
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    await git(['symbolic-ref', 'HEAD', 'refs/heads/ghost'], linked)
    await git(['branch', 'ghost/child'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    const coldListings = worktreeListSpawns()
    expect(coldListings).toBe(1)
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(false)

    for (let read = 0; read < 5; read++) {
      now += MEMBERSHIP_REUSE_WINDOW_MS
      await readWorktreeMembership(repoPath)
    }
    expect(worktreeListSpawns()).toBe(coldListings)

    await git(['worktree', 'lock', linked])
    now += MEMBERSHIP_REUSE_WINDOW_MS
    const { rows } = await readWorktreeMembership(repoPath)
    expect(worktreeListSpawns()).toBe(coldListings + 1)
    expect(rows.find((row) => row.path === linked)).toMatchObject({
      branch: 'refs/heads/ghost',
      locked: true
    })
  })

  it('sees an unmarked change one watcher debounce later, whatever path the repo is registered by', async () => {
    const registered = join(scratchDir, 'repo-link')
    await symlink(repoPath, registered, 'dir')
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(registered)
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    // A watcher-driven read lands one 250 ms trailing debounce after the change, past the window.
    now += 250
    const { rows } = await readWorktreeMembership(registered)
    expect(rows.map((row) => row.path)).toContain(created)
  })

  it("marks every registered repo that shares the changed repo's common dir", async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await Promise.all([readWorktreeMembership(repoPath), readWorktreeMembership(linked)])
    const created = join(scratchDir, 'created')
    await git(['worktree', 'add', '-q', created, '-b', 'created'])
    markWorktreeMembershipDirty(repoPath)
    const { rows } = await readWorktreeMembership(linked)
    expect(rows.map((row) => row.path)).toContain(created)
  })

  it('re-reads every entry once the floor is due', async () => {
    const linked = join(scratchDir, 'linked')
    await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const readAfterWindow = async (): Promise<void> => {
      now += MEMBERSHIP_REUSE_WINDOW_MS
      await readWorktreeMembership(repoPath)
    }
    await readAfterWindow()
    await readAfterWindow()
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    const settled = model.files!.entries.get('linked')
    await readAfterWindow()
    expect(model.files!.entries.get('linked')).toBe(settled)

    model.fullDerivedAt -= MEMBERSHIP_FULL_DERIVE_FLOOR_MS
    await readAfterWindow()
    expect(model.files!.entries.get('linked')).not.toBe(settled)
  })

  it('re-reads only the entry whose files moved', async () => {
    const b = join(scratchDir, 'b')
    await git(['worktree', 'add', '-q', join(scratchDir, 'a'), '-b', 'a'])
    await git(['worktree', 'add', '-q', b, '-b', 'b'])
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await readWorktreeMembership(repoPath)
    now += MEMBERSHIP_REUSE_WINDOW_MS
    await readWorktreeMembership(repoPath)
    const model = _getWorktreeMembershipModelForTests(repoPath)!
    const [aMemo, bMemo] = [model.files!.entries.get('a'), model.files!.entries.get('b')]

    await commitIn(b, 'moved')
    now += MEMBERSHIP_REUSE_WINDOW_MS
    await readWorktreeMembership(repoPath)
    expect(model.files!.entries.get('a')).toBe(aMemo)
    expect(model.files!.entries.get('b')).not.toBe(bMemo)
  })
})

describe('worktree membership model: lifetime', () => {
  it('drops a model whose repo is no longer registered', async () => {
    await readWorktreeMembership(repoPath)
    retainWorktreeMembershipModels([repoPath])
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(true)
    retainWorktreeMembershipModels([])
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(false)
  })

  it('drops a model nobody read for the idle window', async () => {
    const other = join(scratchDir, 'other')
    await mkdir(other)
    await git(['init', '-q', '-b', 'main'], other)
    await readWorktreeMembership(repoPath)
    const now = Date.now() + MEMBERSHIP_IDLE_DROP_MS
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await readWorktreeMembership(other)
    expect(isWorktreeMembershipModelBacked(repoPath)).toBe(false)
    expect(isWorktreeMembershipModelBacked(other)).toBe(true)
  })
})
