import type * as FsPromises from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorktreeBasePollEvent } from '../creation/worktree-base-directory-poller'
import { createGitCommonWatchReconciliation } from './worktree-git-common-watch-reconciliation'

// Perf contract (#48030): the watcher backstop stat'ed every worktree's git metadata every 30 s while the window was
// visible (~200 stats/s at 1,900 worktrees) even though the native watcher already reports changes.

type Node = { dir: boolean; mtimeMs: number; ino: number }
const fs = vi.hoisted(() => ({ nodes: new Map<string, Node>(), stats: 0, clock: 1, ino: 1 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const missing = (path: string): Error =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  const stat = async (path: string) => {
    fs.stats += 1
    const node = fs.nodes.get(String(path))
    if (!node) {
      throw missing(String(path))
    }
    return {
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      ino: node.ino,
      size: 1,
      isFile: () => !node.dir,
      isDirectory: () => node.dir
    }
  }
  const readdir = async (path: string) => {
    if (!fs.nodes.get(String(path))?.dir) {
      throw missing(String(path))
    }
    return [...fs.nodes.keys()]
      .filter((child) => dirname(child) === String(path))
      .map((child) => ({ name: basename(child), isDirectory: () => fs.nodes.get(child)!.dir }))
  }
  return { ...actual, stat, readdir }
})

const COMMON = join('/', 'repo', '.git')
const WORKTREES = join(COMMON, 'worktrees')
const FLEET = 1_900
const POLL_INTERVAL_MS = 2_000

function put(path: string, dir: boolean): void {
  fs.nodes.set(path, { dir, mtimeMs: fs.clock++, ino: fs.ino++ })
  const parent = fs.nodes.get(dirname(path))
  if (parent) {
    parent.mtimeMs = fs.clock++
  }
}

function addWorktreeEntry(name: string): string {
  const entry = join(WORKTREES, name)
  put(entry, true)
  for (const file of ['HEAD', 'gitdir', 'index']) {
    put(join(entry, file), false)
  }
  put(join(entry, 'logs'), true)
  put(join(entry, 'logs', 'HEAD'), false)
  return entry
}

function removeWorktreeEntry(entry: string): void {
  for (const path of fs.nodes.keys()) {
    if (path === entry || path.startsWith(`${entry}/`) || path.startsWith(`${entry}\\`)) {
      fs.nodes.delete(path)
    }
  }
  fs.nodes.get(WORKTREES)!.mtimeMs = fs.clock++
}

let focus: (() => void) | null = null
let reveal: (() => void) | null = null
let onHidden: (() => void) | null = null
function hide(): void {
  visible = false
  onHidden?.()
}
let visible = true
let activity: ((repoId: string) => void) | null = null
let events: WorktreeBasePollEvent[] = []

async function startReconciliation(): Promise<
  ReturnType<typeof createGitCommonWatchReconciliation>
> {
  const reconciliation = createGitCommonWatchReconciliation({
    commonDirPath: COMMON,
    pollIntervalMs: POLL_INTERVAL_MS,
    visibility: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: () => () => {},
      onWindowHidden: (listener) => {
        onHidden = listener
        return () => {
          onHidden = null
        }
      },
      onWindowFocused: (listener) => {
        focus = listener
        return () => {
          focus = null
        }
      }
    },
    canStart: () => true,
    shouldKeep: () => true,
    onRootReplacement: () => {},
    onEvents: (next) => events.push(...next),
    subscribeRepoActivity: (listener) => {
      activity = listener
      return () => {
        activity = null
      }
    },
    ownsRepo: (repoId) => repoId === 'repo'
  })
  await reconciliation.ensureStarted()
  reveal = () => {
    visible = true
    reconciliation.notifyWindowBecameVisible()
  }
  return reconciliation
}

beforeEach(() => {
  vi.useFakeTimers()
  fs.nodes.clear()
  fs.stats = 0
  events = []
  visible = true
  put(join('/', 'repo'), true)
  put(COMMON, true)
  put(WORKTREES, true)
  for (let index = 0; index < FLEET; index += 1) {
    addWorktreeEntry(`w${index}`)
  }
})

afterEach(() => {
  vi.useRealTimers()
})

it('leaves the fleet alone between five-minute sweeps while the watcher is primary', async () => {
  const { unsubscribe: stop } = await startReconciliation()
  fs.stats = 0
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  // Two timed sweeps: 7 stats per entry plus the worktrees directory; the 30 s cadence spent ~129k stats here.
  expect(fs.stats).toBeLessThanOrEqual(2 * (FLEET * 7 + 1))
  await stop()
})

it('still converges on worktrees added or removed outside Orca with no watcher event', async () => {
  const { unsubscribe: stop } = await startReconciliation()
  await vi.advanceTimersByTimeAsync(30_000)
  const added = addWorktreeEntry('outside-add')
  focus?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(events).toContainEqual({ type: 'create', path: added })

  const removed = join(WORKTREES, 'w7')
  removeWorktreeEntry(removed)
  // A second focus inside 30 s is throttled; the five-minute backstop still finds the removal.
  focus?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(events.some((event) => event.path === removed)).toBe(false)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(events).toContainEqual({ type: 'delete', path: removed })
  await stop()
})

it('keeps the five-minute full sweep when the user refocuses Orca every minute', async () => {
  const { unsubscribe: stop } = await startReconciliation()
  // An in-place rewrite that leaves the entry directory's timestamps alone is only seen by a full sweep.
  fs.nodes.get(join(WORKTREES, 'w3', 'index'))!.mtimeMs = fs.clock++
  for (let minute = 0; minute < 6; minute += 1) {
    focus?.()
    await vi.advanceTimersByTimeAsync(60_000)
  }
  expect(events.some((event) => event.path.startsWith(join(WORKTREES, 'w3')))).toBe(true)
  await stop()
})

it('reconciles on focus again after a polling-fallback restart', async () => {
  const reconciliation = await startReconciliation()
  await reconciliation.unsubscribe()
  await reconciliation.ensureStarted()
  await vi.advanceTimersByTimeAsync(60_000)
  const added = addWorktreeEntry('after-restart')
  focus?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(events).toContainEqual({ type: 'create', path: added })
  await reconciliation.unsubscribe()
})

it('never scans more than the old 30 s cadence when focus changes every 30 s', async () => {
  const { unsubscribe: stop } = await startReconciliation()
  fs.stats = 0
  for (let step = 0; step < 20; step += 1) {
    await vi.advanceTimersByTimeAsync(30_000)
    focus?.()
  }
  await vi.advanceTimersByTimeAsync(0)
  // The old cadence spent 129,220 stats in ten idle minutes.
  expect(fs.stats).toBeLessThanOrEqual(129_220)
  await stop()
})

it('forces a full sweep when the window is revealed after a hide of 30 s or more', async () => {
  const { unsubscribe: stop } = await startReconciliation()
  hide()
  // `git worktree lock` without an entry-directory timestamp change and with the watcher event lost.
  const locked = join(WORKTREES, 'w5', 'locked')
  fs.nodes.set(locked, { dir: false, mtimeMs: fs.clock++, ino: fs.ino++ })
  await vi.advanceTimersByTimeAsync(61_000)
  reveal?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(events.some((event) => event.path.startsWith(join(WORKTREES, 'w5')))).toBe(true)
  await stop()
})

it('never scans more than the old 30 s cadence under hide/reveal churn', async () => {
  // [visible ms, hidden ms, stats the old cadence spent over ten minutes of that pattern]
  const patterns = [
    [30_000, 1_000, 129_220],
    [29_500, 1_000, 266_020],
    [45_000, 5_000, 144_420],
    [60_000, 10_000, 157_721],
    [1_000, 30_000, 266_020],
    [30_000, 30_000, 190_020]
  ]
  for (const [visibleMs, hiddenMs, oldCadenceStats] of patterns) {
    const { unsubscribe: stop } = await startReconciliation()
    fs.stats = 0
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += visibleMs + hiddenMs) {
      await vi.advanceTimersByTimeAsync(visibleMs)
      hide()
      await vi.advanceTimersByTimeAsync(hiddenMs)
      reveal?.()
      focus?.()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.stats).toBeLessThanOrEqual(oldCadenceStats)
    await stop()
  }
})

it('runs only the reveal sweep when focus lands before show/restore', async () => {
  const { unsubscribe: stop } = await startReconciliation()
  hide()
  // Long enough that the timed sweep parks while hidden.
  await vi.advanceTimersByTimeAsync(301_000)
  fs.stats = 0
  visible = true
  focus?.()
  reveal?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(fs.stats).toBeLessThanOrEqual(FLEET * 7 + 1)
  await stop()
})

it('re-checks on agent turns and shell commands in this repo, never above the old cadence', async () => {
  const { unsubscribe: stop } = await startReconciliation()
  await vi.advanceTimersByTimeAsync(30_000)
  const added = addWorktreeEntry('agent-add')
  activity?.('other-repo')
  await vi.advanceTimersByTimeAsync(0)
  expect(events).toEqual([])
  activity?.('repo')
  await vi.advanceTimersByTimeAsync(0)
  expect(events).toContainEqual({ type: 'create', path: added })

  // 100 agents each finishing a turn every second for ten minutes.
  fs.stats = 0
  for (let second = 0; second < 600; second += 1) {
    for (let agent = 0; agent < 100; agent += 1) {
      activity?.('repo')
    }
    await vi.advanceTimersByTimeAsync(1_000)
  }
  expect(fs.stats).toBeLessThanOrEqual(129_220)
  await stop()
})
