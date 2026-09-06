import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

const { fsCalls, removeHostTreeMock } = vi.hoisted(() => ({
  fsCalls: { readdir: [] as string[], stat: [] as string[] },
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

vi.mock('./host-tree-removal', () => ({ removeHostTree: removeHostTreeMock }))

// Why wrap the real module rather than stub it: this suite measures how many filesystem
// requests one GC pass issues, so every call has to still hit the disk it is counting.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const call = (name: 'readdir' | 'stat', fn: unknown) => {
    return (...args: unknown[]): unknown => {
      fsCalls[name].push(String(args[0]))
      return (fn as (...a: unknown[]) => unknown)(...args)
    }
  }
  return { ...actual, readdir: call('readdir', actual.readdir), stat: call('stat', actual.stat) }
})

import { readHistoryMeta } from './terminal-history'
import {
  cancelPendingHistoryTreeRemovalRetries,
  flushPendingWorktreeHistoryDeletions
} from './terminal-history-deletion'
import { cancelHistoryGc, runHistoryGc } from './terminal-history-gc'

const GC_MIN_AGE_MS = 5 * 60 * 1000
const PENDING_DELETE_DIR_NAME = '.pending-delete'
const LIVE_WORKTREE_ID = 'repo-1::/path/live-wt'
const DEAD_WORKTREE_ID = 'repo-1::/path/dead-wt'
const DIR_COUNT = 50
const ORPHAN_EVERY = 5

let userDataDir: string
let historyRoot: string
let originalXdgDataHome: string | undefined

/** The pre-dirent decision logic, verbatim apart from reporting names instead of deleting. */
function referencePruneDecisions(root: string, liveWorktreeIds: Set<string>): string[] {
  const decisions: string[] = []
  const now = Date.now()
  for (const entry of readdirSync(root)) {
    if (entry === PENDING_DELETE_DIR_NAME) {
      continue
    }
    const entryPath = join(root, entry)
    try {
      if (!statSync(entryPath).isDirectory()) {
        continue
      }
      const meta = readHistoryMeta(entryPath)
      if (!meta?.worktreeId || liveWorktreeIds.has(meta.worktreeId)) {
        continue
      }
      if (meta.createdAt && now - new Date(meta.createdAt).getTime() < GC_MIN_AGE_MS) {
        continue
      }
      decisions.push(entry)
    } catch {
      // Skip individual entries that fail, as the walk under test does.
    }
  }
  return decisions
}

function seedDir(name: string, files: Record<string, string>): string {
  const dir = join(historyRoot, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(dir, file), contents)
  }
  return dir
}

function meta(worktreeId: string): string {
  return JSON.stringify({
    worktreeId,
    createdAt: new Date(Date.now() - GC_MIN_AGE_MS * 2).toISOString()
  })
}

/** DIR_COUNT directories of three files each: meta.json plus two shell history files. */
function seedFixture(): void {
  for (let i = 0; i < DIR_COUNT; i++) {
    const orphan = i % ORPHAN_EVERY === 0
    seedDir(`wt-${i}`, {
      'meta.json': meta(orphan ? `${DEAD_WORKTREE_ID}-${i}` : LIVE_WORKTREE_ID),
      zsh_history: `entry-${i}`,
      bash_history: `entry-${i}`
    })
  }
}

/** Symlinks included, and tolerant of a broken one, which `statSync` cannot be. */
function survivingDirs(): Set<string> {
  return new Set(
    readdirSync(historyRoot).filter(
      (entry) => entry !== PENDING_DELETE_DIR_NAME && !lstatSync(join(historyRoot, entry)).isFile()
    )
  )
}

/** Stats on the root's own entries — the `isDirectory()` probe the dirent now answers. */
function statsOnEntries(): string[] {
  return fsCalls.stat.filter((path) => dirname(path) === historyRoot)
}

/** Stats on files inside a history directory — the per-file size estimation this pass dropped. */
function statsInsideEntries(): string[] {
  return fsCalls.stat.filter((path) => dirname(dirname(path)) === historyRoot)
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-gc-calls-'))
  historyRoot = join(userDataDir, 'terminal-history')
  mkdirSync(historyRoot, { recursive: true })
  installFakeAppEnvironment({ getPath: () => userDataDir })
  // Why: the fish sweep resolves a real user data dir otherwise, and would delete the
  // developer's own orca fish history files while this suite runs.
  originalXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = userDataDir
  fsCalls.readdir.length = 0
  fsCalls.stat.length = 0
  removeHostTreeMock.mockReset()
  removeHostTreeMock.mockImplementation(async (dir) => {
    rmSync(dir, { recursive: true, force: true })
  })
})

afterEach(async () => {
  cancelHistoryGc()
  await flushPendingWorktreeHistoryDeletions()
  cancelPendingHistoryTreeRemovalRetries()
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome
  }
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('history GC filesystem request count', () => {
  it('issues no per-file stat and one readdir for the whole root', async () => {
    seedFixture()
    const live = new Set([LIVE_WORKTREE_ID])
    const expected = new Set(referencePruneDecisions(historyRoot, live))
    const before = survivingDirs()
    fsCalls.readdir.length = 0
    fsCalls.stat.length = 0

    await runHistoryGc(live)

    // The size estimation walked into every directory; the pass now only lists the root.
    expect(fsCalls.readdir).toEqual([historyRoot])
    // No stat on the entries themselves: the root dirent already carries the type.
    expect(statsOnEntries()).toEqual([])
    // The one surviving stat per directory is readHistoryMetaAsync enforcing its size cap.
    expect(statsInsideEntries().sort()).toEqual(
      Array.from({ length: DIR_COUNT }, (_, i) => join(historyRoot, `wt-${i}`, 'meta.json')).sort()
    )
    expect(fsCalls.readdir.length + fsCalls.stat.length).toBe(1 + DIR_COUNT)

    const after = survivingDirs()
    expect(expected.size).toBe(DIR_COUNT / ORPHAN_EVERY)
    expect([...before].filter((entry) => !after.has(entry)).sort()).toEqual([...expected].sort())
  })

  it('still resolves a symlinked history directory through its target', async () => {
    const orphanTarget = join(userDataDir, 'linked-orphan')
    mkdirSync(orphanTarget, { recursive: true })
    writeFileSync(join(orphanTarget, 'meta.json'), meta(`${DEAD_WORKTREE_ID}-linked`))
    const liveTarget = join(userDataDir, 'linked-live')
    mkdirSync(liveTarget, { recursive: true })
    writeFileSync(join(liveTarget, 'meta.json'), meta(LIVE_WORKTREE_ID))
    try {
      symlinkSync(orphanTarget, join(historyRoot, 'link-orphan'), 'dir')
      symlinkSync(liveTarget, join(historyRoot, 'link-live'), 'dir')
      symlinkSync(join(userDataDir, 'nowhere'), join(historyRoot, 'link-broken'), 'dir')
    } catch {
      // Unprivileged Windows cannot create symlinks; the dirent path is covered above.
      return
    }
    seedDir('plain-orphan', { 'meta.json': meta(`${DEAD_WORKTREE_ID}-plain`) })

    await runHistoryGc(new Set([LIVE_WORKTREE_ID]))

    const after = survivingDirs()
    expect(after.has('link-orphan')).toBe(false)
    expect(after.has('plain-orphan')).toBe(false)
    expect(after.has('link-live')).toBe(true)
    // A dangling link fails its stat and is skipped, exactly as the pre-dirent walk skipped it.
    expect(after.has('link-broken')).toBe(true)
    // Only the links cost a stat on the entry itself; plain-orphan costs none.
    expect(statsOnEntries().sort()).toEqual(
      ['link-broken', 'link-live', 'link-orphan'].map((name) => join(historyRoot, name))
    )
  })
})
