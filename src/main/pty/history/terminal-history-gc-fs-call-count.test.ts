import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const { fsCalls, removeHostTreeMock } = vi.hoisted(() => ({
  fsCalls: { readdir: [] as string[], stat: [] as string[] },
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>()
}))

vi.mock('../../filesystem/host-tree-removal', () => ({ removeHostTree: removeHostTreeMock }))

// Count real filesystem calls so the measured I/O still reaches disk.
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

import {
  cancelPendingHistoryTreeRemovalRetries,
  flushPendingWorktreeHistoryDeletions
} from './terminal-history-deletion'
import { cancelHistoryGc, runHistoryGc } from './terminal-history-gc'

const GC_MIN_AGE_MS = 5 * 60 * 1000
const PENDING_DELETE_DIR_NAME = '.pending-delete'
const LIVE_WORKTREE_ID = 'repo-1::/path/live-wt'
const DEAD_WORKTREE_ID = 'repo-1::/path/dead-wt'

let userDataDir: string
let historyRoot: string
let originalXdgDataHome: string | undefined

// Pre-dirent pruning oracle; reports names instead of deleting.

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

function survivingDirs(): Set<string> {
  return new Set(
    readdirSync(historyRoot).filter(
      (entry) => entry !== PENDING_DELETE_DIR_NAME && !lstatSync(join(historyRoot, entry)).isFile()
    )
  )
}

function statsOnEntries(): string[] {
  return fsCalls.stat.filter((path) => dirname(path) === historyRoot)
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-gc-calls-'))
  historyRoot = join(userDataDir, 'terminal-history')
  mkdirSync(historyRoot, { recursive: true })
  installFakeAppEnvironment({ getPath: () => userDataDir })
  // Isolate fish data so the sweep cannot delete the developer's own history.
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
      // Unprivileged Windows may refuse symlink creation.
      return
    }
    seedDir('plain-orphan', { 'meta.json': meta(`${DEAD_WORKTREE_ID}-plain`) })

    await runHistoryGc(new Set([LIVE_WORKTREE_ID]))

    const after = survivingDirs()
    expect(after.has('link-orphan')).toBe(false)
    expect(after.has('plain-orphan')).toBe(false)
    expect(after.has('link-live')).toBe(true)
    expect(after.has('link-broken')).toBe(true)
    expect(statsOnEntries().sort()).toEqual(
      ['link-broken', 'link-live', 'link-orphan'].map((name) => join(historyRoot, name))
    )
  })
})
