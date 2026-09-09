import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

const { removeHostTreeMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

// Why intercept rather than no-op: the tombstone path each prune produces is the decision this
// suite reads, but the drain re-queues any tombstone still on disk after a "successful" removal,
// so the stub has to really delete or the queue never terminates.
vi.mock('./host-tree-removal', () => ({
  removeHostTree: removeHostTreeMock
}))

import { readHistoryMeta } from './terminal-history'
import {
  cancelPendingHistoryTreeRemovalRetries,
  flushPendingWorktreeHistoryDeletions
} from './terminal-history-deletion'
import { cancelHistoryGc, runHistoryGc, scheduleHistoryGc } from './terminal-history-gc'

const GC_MIN_AGE_MS = 5 * 60 * 1000
const PENDING_DELETE_DIR_NAME = '.pending-delete'
const LIVE_WORKTREE_ID = 'repo-1::/path/live-wt'
const DEAD_WORKTREE_ID = 'repo-1::/path/dead-wt'

let userDataDir: string
let historyRoot: string
let originalXdgDataHome: string | undefined

/**
 * The enumeration this exercises used to be a synchronous walk. Its replacement is an async
 * fixed-worker pass, so the whole safety net is that both reach the same prune decision over a
 * realistic tree: over-pruning here destroys scrollback the user still expects to have.
 *
 * A verbatim port of the pre-change decision logic, reporting names instead of deleting.
 */
function referenceSyncPruneDecisions(root: string, liveWorktreeIds: Set<string>): string[] {
  const decisions: string[] = []
  if (!existsSync(root)) {
    return decisions
  }
  const now = Date.now()
  for (const entry of readdirSync(root)) {
    if (entry === PENDING_DELETE_DIR_NAME) {
      continue
    }
    const entryPath = join(root, entry)
    try {
      const stats = statSync(entryPath)
      if (!stats.isDirectory()) {
        continue
      }
      try {
        for (const file of readdirSync(entryPath)) {
          statSync(join(entryPath, file))
        }
      } catch {
        // Skip size estimation on error.
      }
      if (!existsSync(join(entryPath, 'meta.json'))) {
        continue
      }
      const meta = readHistoryMeta(entryPath)
      if (!meta?.worktreeId) {
        continue
      }
      if (!liveWorktreeIds.has(meta.worktreeId)) {
        if (meta.createdAt && now - new Date(meta.createdAt).getTime() < GC_MIN_AGE_MS) {
          continue
        }
        decisions.push(entry)
      }
    } catch {
      // Skip individual entries that fail.
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

function meta(worktreeId: string | undefined, ageMs: number | null): string {
  return JSON.stringify({
    ...(worktreeId === undefined ? {} : { worktreeId }),
    ...(ageMs === null ? {} : { createdAt: new Date(Date.now() - ageMs).toISOString() })
  })
}

const OLD = GC_MIN_AGE_MS * 2

/** Every decision shape the walk has to get right, including the ones that must never prune. */
function seedDecisionMatrix(): void {
  seedDir('live-old', { 'meta.json': meta(LIVE_WORKTREE_ID, OLD), zsh_history: 'a' })
  seedDir('live-young', { 'meta.json': meta(LIVE_WORKTREE_ID, 0) })
  seedDir('orphan-old', { 'meta.json': meta(DEAD_WORKTREE_ID, OLD), zsh_history: 'b' })
  seedDir('orphan-no-createdat', { 'meta.json': meta(DEAD_WORKTREE_ID, null) })
  seedDir('orphan-unparseable-createdat', {
    'meta.json': JSON.stringify({ worktreeId: DEAD_WORKTREE_ID, createdAt: 'not-a-date' })
  })
  seedDir('orphan-young', { 'meta.json': meta(DEAD_WORKTREE_ID, 1_000) })
  seedDir('no-meta', { zsh_history: 'c' })
  seedDir('malformed-meta', { 'meta.json': '{ this is not json' })
  seedDir('truncated-meta', { 'meta.json': `{"worktreeId":"${DEAD_WORKTREE_ID}` })
  seedDir('empty-meta', { 'meta.json': '{}' })
  seedDir('array-meta', { 'meta.json': `["${DEAD_WORKTREE_ID}"]` })
  seedDir('null-meta', { 'meta.json': 'null' })
  seedDir('no-worktree-id', { 'meta.json': meta(undefined, OLD) })
  seedDir('oversize-meta', {
    'meta.json': JSON.stringify({
      worktreeId: DEAD_WORKTREE_ID,
      createdAt: new Date(Date.now() - OLD).toISOString(),
      pad: 'x'.repeat(64 * 1024)
    })
  })
  // meta.json as a directory: stat succeeds, the read does not.
  mkdirSync(join(historyRoot, 'meta-is-a-dir', 'meta.json'), { recursive: true })
  seedDir('empty-dir', {})
  // A plain file at the root is not a history directory.
  writeFileSync(join(historyRoot, 'stray-file'), 'x')
  mkdirSync(join(historyRoot, PENDING_DELETE_DIR_NAME), { recursive: true })
}

/** Enough entries to run several worker batches and cross the cooperative-yield boundary. */
function seedBulk(count: number, orphanEvery: number): void {
  for (let i = 0; i < count; i++) {
    const orphan = i % orphanEvery === 0
    seedDir(`bulk-${i}`, {
      'meta.json': meta(orphan ? `${DEAD_WORKTREE_ID}-${i}` : LIVE_WORKTREE_ID, OLD),
      zsh_history: `entry-${i}`,
      bash_history: `entry-${i}`
    })
  }
}

function survivingDirs(): Set<string> {
  return new Set(
    readdirSync(historyRoot).filter(
      (entry) =>
        entry !== PENDING_DELETE_DIR_NAME && statSync(join(historyRoot, entry)).isDirectory()
    )
  )
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-gc-'))
  historyRoot = join(userDataDir, 'terminal-history')
  mkdirSync(historyRoot, { recursive: true })
  installFakeAppEnvironment({ getPath: () => userDataDir })
  // Why: the fish sweep resolves a real user data dir otherwise, and would delete the
  // developer's own orca fish history files while this suite runs.
  originalXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = userDataDir
  removeHostTreeMock.mockReset()
  removeHostTreeMock.mockImplementation(async (dir) => {
    rmSync(dir, { recursive: true, force: true })
  })
})

/** Tombstone paths the pass condemned, with the `.<timestamp>.<rand>` rename suffix stripped. */
function tombstonedNames(): Set<string> {
  return new Set(
    removeHostTreeMock.mock.calls.map(([dir]) => basename(dir).split('.').slice(0, -2).join('.'))
  )
}

afterEach(async () => {
  cancelHistoryGc()
  vi.useRealTimers()
  await flushPendingWorktreeHistoryDeletions()
  cancelPendingHistoryTreeRemovalRetries()
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome
  }
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('history GC prune decisions', () => {
  it('prunes exactly the set the synchronous walk chose', async () => {
    seedDecisionMatrix()
    seedBulk(200, 7)
    const live = new Set([LIVE_WORKTREE_ID])

    const before = survivingDirs()
    const expected = new Set(referenceSyncPruneDecisions(historyRoot, live))

    await runHistoryGc(live)

    const after = survivingDirs()
    const actual = new Set([...before].filter((entry) => !after.has(entry)))

    expect(expected.size).toBeGreaterThan(0)
    expect([...actual].sort()).toEqual([...expected].sort())
  })

  it('keeps every directory whose ownership cannot be established', async () => {
    seedDecisionMatrix()

    await runHistoryGc(new Set([LIVE_WORKTREE_ID]))

    const after = survivingDirs()
    for (const kept of [
      'live-old',
      'live-young',
      'orphan-young',
      'no-meta',
      'malformed-meta',
      'truncated-meta',
      'empty-meta',
      'array-meta',
      'null-meta',
      'no-worktree-id',
      'oversize-meta',
      'meta-is-a-dir',
      'empty-dir'
    ]) {
      expect(after.has(kept)).toBe(true)
    }
    expect(after.has('orphan-old')).toBe(false)
    expect(after.has('orphan-no-createdat')).toBe(false)
    expect(after.has('orphan-unparseable-createdat')).toBe(false)
    expect(existsSync(join(historyRoot, 'stray-file'))).toBe(true)
  })

  it('refuses to prune anything when the live set is empty', async () => {
    seedDecisionMatrix()

    await runHistoryGc(new Set())

    expect(survivingDirs().has('orphan-old')).toBe(true)
    expect(readdirSync(join(historyRoot, PENDING_DELETE_DIR_NAME))).toEqual([])
  })

  it('does not throw when the history root does not exist', async () => {
    rmSync(historyRoot, { recursive: true, force: true })
    await expect(runHistoryGc(new Set([LIVE_WORKTREE_ID]))).resolves.toBeUndefined()
  })

  it('tombstones orphans instead of removing them on the calling thread', async () => {
    seedDecisionMatrix()

    await runHistoryGc(new Set([LIVE_WORKTREE_ID]))

    // The recursive rm only ever sees a path already renamed into the tombstone queue.
    for (const [dir] of removeHostTreeMock.mock.calls) {
      expect(dir).toContain(PENDING_DELETE_DIR_NAME)
    }
    expect(tombstonedNames().has('orphan-old')).toBe(true)
  })

  it('drains pre-existing tombstones without scanning them as worktrees', async () => {
    seedDecisionMatrix()
    const leftover = join(historyRoot, PENDING_DELETE_DIR_NAME, 'abc123.1700000000000.deadbeef')
    mkdirSync(leftover, { recursive: true })

    await runHistoryGc(new Set([LIVE_WORKTREE_ID]))

    expect(removeHostTreeMock).toHaveBeenCalledWith(expect.stringContaining('abc123.1700000000000'))
  })

  it('continues the pass after one orphan tombstone fails', async () => {
    seedDir('orphan-a', { 'meta.json': meta(`${DEAD_WORKTREE_ID}-a`, OLD) })
    seedDir('orphan-b', { 'meta.json': meta(`${DEAD_WORKTREE_ID}-b`, OLD) })
    // A file where the tombstone root must be makes the first rename fail; mkdir cannot replace it.
    writeFileSync(join(historyRoot, PENDING_DELETE_DIR_NAME), 'not a directory')

    await expect(runHistoryGc(new Set([LIVE_WORKTREE_ID]))).resolves.toBeUndefined()

    // Nothing could be tombstoned, and both entries survive for a later pass to reclaim.
    expect(survivingDirs()).toEqual(new Set(['orphan-a', 'orphan-b']))
  })
})

describe('history GC concurrency behaviour', () => {
  it('joins a second call to the in-flight pass instead of walking twice', async () => {
    seedDecisionMatrix()
    const live = new Set([LIVE_WORKTREE_ID])

    const first = runHistoryGc(live)
    const second = runHistoryGc(live)
    expect(second).toBe(first)

    await first
    // Each rename produces its own tombstone, so a second overlapping walk would condemn twice.
    const orphanRemovals = removeHostTreeMock.mock.calls.filter(([dir]) =>
      basename(dir).startsWith('orphan-old.')
    )
    expect(orphanRemovals).toHaveLength(1)
  })

  it('starts a fresh pass once the previous one has settled', async () => {
    seedDecisionMatrix()
    const live = new Set([LIVE_WORKTREE_ID])
    await runHistoryGc(live)
    const second = runHistoryGc(live)
    await expect(second).resolves.toBeUndefined()
  })

  it('stops an in-flight walk on cancel without pruning', async () => {
    seedDecisionMatrix()
    seedBulk(300, 3)
    const before = survivingDirs()

    const pass = runHistoryGc(new Set([LIVE_WORKTREE_ID]))
    // Cancelling before the root listing resolves means no entry is ever visited.
    cancelHistoryGc()
    await pass

    expect(survivingDirs()).toEqual(before)
  })

  it('does not run a scheduled pass that was cancelled while resolving live worktrees', async () => {
    seedDecisionMatrix()
    vi.useFakeTimers()
    let resolveLiveIds: (ids: Set<string>) => void = () => {}
    scheduleHistoryGc(
      () =>
        new Promise<Set<string>>((resolve) => {
          resolveLiveIds = resolve
        })
    )

    await vi.advanceTimersByTimeAsync(10_000)
    cancelHistoryGc()
    resolveLiveIds(new Set([LIVE_WORKTREE_ID]))
    await vi.advanceTimersByTimeAsync(0)

    expect(survivingDirs().has('orphan-old')).toBe(true)
  })

  it('coalesces duplicate scheduled startup GC calls', async () => {
    vi.useFakeTimers()
    const getLiveWorktreeIds = vi.fn().mockResolvedValue(new Set<string>())

    scheduleHistoryGc(getLiveWorktreeIds)
    scheduleHistoryGc(getLiveWorktreeIds)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(getLiveWorktreeIds).toHaveBeenCalledTimes(1)
  })
})

describe('history GC races an async walk introduces', () => {
  it('survives a directory removed while the walk is in flight', async () => {
    seedDecisionMatrix()
    seedBulk(300, 5)
    const live = new Set([LIVE_WORKTREE_ID])
    const vanishing = ['bulk-11', 'bulk-77', 'bulk-201']

    const pass = runHistoryGc(live)
    for (const name of vanishing) {
      rmSync(join(historyRoot, name), { recursive: true, force: true })
    }
    await expect(pass).resolves.toBeUndefined()

    // Every live directory the racer did not touch is still there.
    expect(survivingDirs().has('live-old')).toBe(true)
    expect(survivingDirs().has('bulk-1')).toBe(true)
    for (const name of vanishing) {
      expect(existsSync(join(historyRoot, name))).toBe(false)
    }
  })

  it('never prunes a directory whose meta.json is half-written when the walk reads it', async () => {
    seedDir('being-written', {})
    seedBulk(200, 5)
    const live = new Set([LIVE_WORKTREE_ID])

    const pass = runHistoryGc(live)
    writeFileSync(
      join(historyRoot, 'being-written', 'meta.json'),
      `{"worktreeId":"${DEAD_WORKTREE_ID}","created`
    )
    await pass

    expect(survivingDirs().has('being-written')).toBe(true)
  })

  it('prunes a directory whose meta.json arrived after the directory did', async () => {
    seedDir('late-meta', {})
    writeFileSync(
      join(historyRoot, 'late-meta', 'meta.json'),
      meta(`${DEAD_WORKTREE_ID}-late`, OLD)
    )

    await runHistoryGc(new Set([LIVE_WORKTREE_ID]))

    expect(survivingDirs().has('late-meta')).toBe(false)
  })
})

describe('history GC main-thread occupancy', () => {
  it('yields to timers throughout the walk instead of blocking on it', async () => {
    seedBulk(1_200, 40)
    const live = new Set([LIVE_WORKTREE_ID])

    const ticks = { sync: 0, async: 0 }
    let maxAsyncGapMs = 0

    // The pre-change walk is the control: a synchronous pass over the same tree cannot tick at all.
    const syncTimer = setInterval(() => {
      ticks.sync += 1
    }, 4)
    referenceSyncPruneDecisions(historyRoot, live)
    clearInterval(syncTimer)

    let last = performance.now()
    const asyncTimer = setInterval(() => {
      const now = performance.now()
      maxAsyncGapMs = Math.max(maxAsyncGapMs, now - last - 4)
      last = now
      ticks.async += 1
    }, 4)
    await runHistoryGc(live)
    clearInterval(asyncTimer)

    // A synchronous pass cannot tick at all, however long it takes.
    expect(ticks.sync).toBe(0)
    expect(ticks.async).toBeGreaterThan(5)
    // Generous because shared CI runners stall an idle timer by tens of ms on their own; the
    // failure this guards against is a whole-walk block, which is seconds.
    expect(maxAsyncGapMs).toBeLessThan(2_000)
  })
})
