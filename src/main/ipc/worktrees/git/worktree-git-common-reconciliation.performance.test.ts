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
let events: WorktreeBasePollEvent[] = []

async function startReconciliation(): Promise<
  ReturnType<typeof createGitCommonWatchReconciliation>
> {
  const reconciliation = createGitCommonWatchReconciliation({
    commonDirPath: COMMON,
    pollIntervalMs: POLL_INTERVAL_MS,
    visibility: {
      isWindowVisible: () => true,
      onWindowBecameVisible: () => () => {},
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
    onEvents: (next) => events.push(...next)
  })
  await reconciliation.ensureStarted()
  return reconciliation
}

beforeEach(() => {
  vi.useFakeTimers()
  fs.nodes.clear()
  fs.stats = 0
  events = []
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
