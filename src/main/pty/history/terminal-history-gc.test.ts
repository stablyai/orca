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
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const { removeHostTreeMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

// The stub must delete tombstones: reporting success while leaving them on disk loops the drain.
vi.mock('../../filesystem/host-tree-removal', () => ({
  removeHostTree: removeHostTreeMock
}))

import * as eventLoopYield from '../../../shared/event-loop-yield'
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
  // stat succeeds on a directory, but reading it as meta.json fails.
  mkdirSync(join(historyRoot, 'meta-is-a-dir', 'meta.json'), { recursive: true })
  seedDir('empty-dir', {})
  writeFileSync(join(historyRoot, 'stray-file'), 'x')
  mkdirSync(join(historyRoot, PENDING_DELETE_DIR_NAME), { recursive: true })
}

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
  // Isolate fish data so the sweep cannot delete the developer's own history.
  originalXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = userDataDir
  removeHostTreeMock.mockReset()
  removeHostTreeMock.mockImplementation(async (dir) => {
    rmSync(dir, { recursive: true, force: true })
  })
})

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
})

describe('history GC concurrency behaviour', () => {
  it('joins a second call to the in-flight pass instead of walking twice', async () => {
    seedDecisionMatrix()
    const live = new Set([LIVE_WORKTREE_ID])

    seedBulk(64, 64)
    const reachedYield = Promise.withResolvers<void>()
    const releaseYield = Promise.withResolvers<void>()
    const originalYield = eventLoopYield.yieldToEventLoop
    const yieldObserver = vi
      .spyOn(eventLoopYield, 'yieldToEventLoop')
      .mockImplementationOnce(async () => {
        reachedYield.resolve()
        await releaseYield.promise
        await originalYield()
      })

    const first = runHistoryGc(live)
    let second: Promise<void> | undefined
    try {
      await reachedYield.promise
      // Starting a separate pass with this snapshot would delete the first caller's live history.
      second = runHistoryGc(new Set([DEAD_WORKTREE_ID]))
      releaseYield.resolve()
      await Promise.all([first, second])

      expect(survivingDirs().has('live-old')).toBe(true)
      expect(survivingDirs().has('orphan-old')).toBe(false)
    } finally {
      releaseYield.resolve()
      await Promise.all([first, second])
      yieldObserver.mockRestore()
    }
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
})
