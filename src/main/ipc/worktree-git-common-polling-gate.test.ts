import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import { startGitCommonPolling } from './worktree-git-common-polling'
import { startGitCommonWatch } from './worktree-git-common-watch'

const POLL_MS = 25
const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

type VisibilityHarness = {
  source: WorktreePollerWindowVisibility
  hide: () => void
  show: () => void
}

function createVisibilityHarness(initiallyVisible = true): VisibilityHarness {
  let visible = initiallyVisible
  let listener: (() => void) | null = null
  return {
    source: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (nextListener) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) {
            listener = null
          }
        }
      }
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
      listener?.()
    }
  }
}

describe('worktree git-common polling gate (unsupported platform)', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function makePollingCommonDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-polling-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const commonDir = await realpath(root)
    await mkdir(join(commonDir, 'worktrees'))
    return commonDir
  }

  function makePollingTarget(path: string): WorktreeBaseWatchTarget {
    return {
      key: `git-common:local:${path}`,
      kind: 'git-common',
      path,
      repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
    }
  }

  async function startPollingWatch(
    commonDir: string,
    received: WorktreeBasePollEvent[][],
    onFullScan?: () => void,
    visibility: WorktreePollerWindowVisibility = alwaysVisible,
    getStatusRefPaths: () => readonly string[] = () => []
  ): Promise<void> {
    const watch = await startGitCommonWatch(
      makePollingTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'freebsd',
      visibility,
      onFullScan,
      getStatusRefPaths
    )
    cleanups.push(() => watch.unsubscribe())
  }

  it('skips the ungated index-metadata backstop on idle ticks', async () => {
    // Why: idle ticks still re-stat structural leaves and list the (small) worktrees dir cheaply, but the
    // heavier ungated per-entry index fan-out (onFullScan) must NOT run until the backstop — and no
    // spurious events are emitted while nothing changes.
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'idle')
    await mkdir(join(entry, 'logs'), { recursive: true })
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
    await writeFile(join(entry, 'logs', 'HEAD'), 'baseline\n')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()

    await startPollingWatch(commonDir, received, fullScans)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 6))

    expect(fullScans).not.toHaveBeenCalled()
    expect(received.flat()).toHaveLength(0)
  })

  it('forces the linked-index scan on every reconciliation tick', async () => {
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'reconciliation')
    await mkdir(entry)
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
    await writeFile(join(entry, 'index'), 'baseline')
    const fullScans = vi.fn()
    const watch = await startGitCommonPolling(
      commonDir,
      () => {},
      50,
      alwaysVisible,
      fullScans,
      false,
      () => [],
      { forceFullScanEveryTick: true }
    )
    cleanups.push(() => watch.unsubscribe())

    // Real filesystem stats cannot be flushed by a fake clock. Two scans must
    // arrive before the ordinary 15-tick (750ms) index backstop could fire.
    await vi.waitFor(
      () => {
        expect(fullScans.mock.calls.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 500 }
    )
  })

  it('detects linked worktree add and remove from the every-tick readdir', async () => {
    // Why: the worktrees-dir listing runs every tick (not gated on its stat signature), so an add/remove
    // surfaces within one poll interval even on a coarse-mtime filesystem whose dir signature would not
    // move — without waiting on the index backstop (onFullScan).
    const commonDir = await makePollingCommonDir()
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    const entry = join(commonDir, 'worktrees', 'added')
    await mkdir(entry)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'create', path: entry })
    })
    // The add is caught by the every-tick listing, NOT the 15-tick index backstop: detection lands well
    // before a backstop could fire, so onFullScan must not have run. (On the old gated impl a coarse-FS
    // signature collision would have deferred this to the backstop.)
    expect(fullScans).not.toHaveBeenCalled()

    await rm(entry, { recursive: true })
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'delete', path: entry })
    })
  })

  // Why runIf: chmod 0 cannot revoke directory listing on Windows or for root, so the EACCES injection is inert there.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'does not fabricate worktree deletions when the readdir fails non-ENOENT (transient)',
    async () => {
      // Why: a transient readdir failure (EIO/ESTALE/EMFILE/EACCES, network/SSH hiccup) must not be read
      // as "every linked worktree removed". Revoke dir permissions so readdir throws EACCES; the known
      // entry must NOT be reported deleted. On the old catch-all (entryPaths = []) this emitted a false
      // delete for every entry. chmod (not a dir->file swap) because it is one atomic syscall: an
      // in-flight tick's threadpool readdir sees success or EACCES, never a transient ENOENT window
      // that would legitimately emit a delete and flake this assertion.
      const commonDir = await makePollingCommonDir()
      const entry = join(commonDir, 'worktrees', 'keep')
      await mkdir(entry)
      await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
      const received: WorktreeBasePollEvent[][] = []
      await startPollingWatch(commonDir, received)

      await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
      const worktreesDir = join(commonDir, 'worktrees')
      chmodSync(worktreesDir, 0o000)
      try {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
      } finally {
        // Why: restore before cleanup so the afterEach recursive rm can traverse the dir.
        chmodSync(worktreesDir, 0o755)
      }

      expect(received.flat()).not.toContainEqual({ type: 'delete', path: entry })
    }
  )

  it('detects an in-place structural (HEAD) write on a known entry every tick, without the index backstop', async () => {
    // Why: a raw HEAD/gitdir/config.worktree rewrite does not bump the entry-dir mtime, so the
    // structural leaves are re-stat'd every tick (never gated) — the change surfaces within one tick
    // and does NOT require the ungated index-metadata backstop (onFullScan).
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'structural')
    await mkdir(entry)
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    const headPath = join(entry, 'HEAD')
    // In-place rewrite: same file, different contents — no entry-dir mtime change.
    await writeFile(headPath, 'ref: refs/heads/feature')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headPath })
    })
    expect(fullScans).not.toHaveBeenCalled()
  })

  it('polls linked logs/HEAD on every idle tick', async () => {
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'reflog')
    await mkdir(join(entry, 'logs'), { recursive: true })
    const headLogPath = join(entry, 'logs', 'HEAD')
    await writeFile(headLogPath, 'baseline\n')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    await appendFile(headLogPath, 'next\n')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headLogPath })
    })
    expect(fullScans).not.toHaveBeenCalled()
  })

  it('polls the common config so an external push -u surfaces its new upstream', async () => {
    // Why: `git push -u` from an external shell rewrites only the common
    // config (plus remote-tracking refs); the primary-metadata list must
    // surface it or the upstream stays invisible until a safety poll.
    const commonDir = await makePollingCommonDir()
    const configPath = join(commonDir, 'config')
    await writeFile(configPath, '[core]\n\tbare = false\n')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    await appendFile(configPath, '[branch "main"]\n\tremote = origin\n')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: configPath })
    })
    expect(fullScans).not.toHaveBeenCalled()
  })

  it('detects create, update, and delete for one transient upstream ref', async () => {
    const commonDir = await makePollingCommonDir()
    const refPath = join(commonDir, 'refs', 'remotes', 'origin', 'feature', 'nested')
    await mkdir(join(commonDir, 'refs', 'remotes', 'origin', 'feature'), { recursive: true })
    const received: WorktreeBasePollEvent[][] = []
    await startPollingWatch(commonDir, received, undefined, alwaysVisible, () => [refPath])

    await writeFile(refPath, 'aaa\n')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'create', path: refPath })
    })
    received.length = 0
    await appendFile(refPath, 'bbb\n')
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: refPath })
    })
    received.length = 0
    await rm(refPath)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'delete', path: refPath })
    })
  })

  it('forces a full scan on the 15-tick backstop', async () => {
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'backstop')
    await mkdir(entry)
    await writeFile(join(entry, 'index'), 'baseline')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    await startPollingWatch(commonDir, received, fullScans)

    await vi.waitFor(() => {
      expect(fullScans).toHaveBeenCalledTimes(1)
    })
    expect(received.flat()).toHaveLength(0)
  })

  it('forces a full fan-out when resuming after hidden', async () => {
    const commonDir = await makePollingCommonDir()
    const entry = join(commonDir, 'worktrees', 'resume')
    await mkdir(entry)
    const indexPath = join(entry, 'index')
    await writeFile(indexPath, 'before')
    const received: WorktreeBasePollEvent[][] = []
    const fullScans = vi.fn()
    const visibility = createVisibilityHarness()
    await startPollingWatch(commonDir, received, fullScans, visibility.source)

    visibility.hide()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    await writeFile(indexPath, 'after-longer')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    expect(fullScans).not.toHaveBeenCalled()
    expect(received.flat()).toHaveLength(0)

    visibility.show()
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: indexPath })
    })
    expect(fullScans).toHaveBeenCalledTimes(1)
  })
})
