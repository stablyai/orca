import { statfs } from 'node:fs/promises'
import { webContents } from 'electron'
import {
  isDiskAlmostFull,
  type PerfNoticeDisk,
  type PerfNoticeSignals
} from '../../shared/diagnostics/perf-notice-signals'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { Repo } from '../../shared/repository/repo-types'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import { getBrowserPageIdleDiscard } from '../browser/guest-lifecycle/browser-page-idle-discard'
import { canReserveBrowserPageDiscard } from '../browser/guest-lifecycle/browser-page-memory'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { readBrowserGuestDiscardAdmission } from '../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection'
import {
  computeWorkspaceRoot,
  getWorktreePathSettings,
  workspaceRootMirrorsIntoWsl
} from '../ipc/worktrees/paths/worktree-logic'
import { getWorktreeMirrorDistroForRuntime } from '../workspaces/execution-host/project-runtime-git-options'
import {
  resolveLocalProjectRuntimesForRepos,
  type ProjectRuntimeResolutionStore
} from '../workspaces/execution-host/local-project-runtime-resolution'
import { wslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'

const DISK_READ_INTERVAL_MS = 10 * 60_000
const DISK_READ_DEADLINE_MS = 15_000

type PerfNoticeSignalStore = Omit<ProjectRuntimeResolutionStore, 'getSettings'> & {
  getSettings: () => Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'> &
    ReturnType<NonNullable<ProjectRuntimeResolutionStore['getSettings']>>
  getRepos: () => Repo[]
  getAllWorktreeMetaForHost: (
    executionHostId: typeof LOCAL_EXECUTION_HOST_ID
  ) => Record<string, { archivedCheckout?: unknown }>
}

/** A filesystem call still running. While one is, no other starts: a dead mount then holds one
 *  libuv thread, not the whole pool, and disk checks resume once it returns. */
let callInFlight = false

let disk: {
  key: string
  readAt: number
  settled: boolean
  /** Shared by every caller, so a hung read gains no handlers per check. */
  bounded: Promise<PerfNoticeDisk | null>
} | null = null

/** The folders whose disks hold local workspaces: where each project creates new ones (resolved as
 *  creation does), then each existing workspace itself, since one can be its own mounted volume.
 *  WSL roots are skipped: resolving or reading them can wake a distro. */
function localWorktreeRoots(store: PerfNoticeSignalStore): string[] {
  const settings = store.getSettings()
  const repos = store
    .getRepos()
    .filter(
      (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID && !isFolderRepo(repo)
    )
  // Why: one pass over projects for every repo, not one per repo.
  const runtimes =
    process.platform === 'win32' ? resolveLocalProjectRuntimesForRepos(store, repos) : null
  const roots = new Map<string, string>()
  const add = (path: string): void => {
    const key = normalizeRuntimePathForComparison(path)
    if (!roots.has(key) && !wslDistroForPath(path)) {
      roots.set(key, path)
    }
  }
  const checkoutByRepoId = new Map<string, string>()
  for (const repo of repos) {
    const mirrorDistro = runtimes
      ? getWorktreeMirrorDistroForRuntime(runtimes.get(repo.id))
      : undefined
    // Why: workspaces made before a switch to WSL stay on the Windows disk.
    checkoutByRepoId.set(repo.id, normalizeRuntimePathForComparison(repo.path))
    const pathSettings = getWorktreePathSettings(repo, settings, mirrorDistro)
    if (!workspaceRootMirrorsIntoWsl(repo.path, pathSettings)) {
      add(computeWorkspaceRoot(repo.path, pathSettings))
    }
  }
  // Why: this machine's rows only; remote hosts can reuse a repo id for their own paths.
  const metaById = store.getAllWorktreeMetaForHost(LOCAL_EXECUTION_HOST_ID)
  for (const [worktreeId, meta] of Object.entries(metaById)) {
    const parsed = splitWorktreeId(worktreeId)
    const checkout = parsed ? checkoutByRepoId.get(parsed.repoId) : undefined
    if (
      parsed &&
      checkout !== undefined &&
      !meta.archivedCheckout &&
      normalizeRuntimePathForComparison(parsed.worktreePath) !== checkout
    ) {
      add(parsed.worktreePath)
    }
  }
  return [...roots.values()]
}

async function statDisk(path: string): Promise<PerfNoticeDisk | null> {
  try {
    const stats = await statfs(path)
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
  } catch {
    // A root not created yet, or on an unplugged volume, has no workspaces to clean up.
    return null
  }
}

/** `complete` is false when another call still running cut the scan short. */
async function readFullestDisk(
  roots: string[]
): Promise<{ disk: PerfNoticeDisk | null; complete: boolean }> {
  let first: PerfNoticeDisk | null = null
  for (const root of roots) {
    if (callInFlight) {
      return { disk: first, complete: false }
    }
    callInFlight = true
    let disk: PerfNoticeDisk | null
    try {
      disk = await statDisk(root)
    } finally {
      callInFlight = false
    }
    if (isDiskAlmostFull(disk)) {
      return { disk, complete: true }
    }
    first ??= disk
  }
  return { disk: first, complete: true }
}

/** A hung mount answers "no reading" so the notice loop moves on. */
function withDeadline(read: Promise<PerfNoticeDisk | null>): Promise<PerfNoticeDisk | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DISK_READ_DEADLINE_MS)
  })
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer))
}

/** Cached for 10 minutes per set of roots; concurrent callers share one read until its result
 *  or its deadline. */
export function readPerfNoticeSignals(store: PerfNoticeSignalStore): Promise<PerfNoticeSignals> {
  const roots = localWorktreeRoots(store)
  const key = roots.join('\0')
  const now = Date.now()
  let current = disk
  const stale = !current || current.key !== key || now - current.readAt >= DISK_READ_INTERVAL_MS
  if (!current || (stale && current.settled)) {
    const scan = readFullestDisk(roots)
    const read = {
      key,
      readAt: now,
      settled: false,
      bounded: withDeadline(scan.then((result) => result.disk))
    }
    void read.bounded.finally(() => {
      read.settled = true
    })
    // Why: a read slower than the deadline still lands in the cache, so the next check uses it.
    void scan.then(({ disk: result, complete }) => {
      if (!complete) {
        // Why: a scan cut short read nothing new; caching it would hide these roots for 10 minutes.
        if (disk === read) {
          disk = null
        }
      } else if (!disk || disk.key === key) {
        disk = { key, readAt: Date.now(), settled: true, bounded: Promise.resolve(result) }
      }
    })
    current = disk = read
  }
  // Why: a read under way for roots the user has since changed says nothing about the new ones.
  if (current.key !== key) {
    return Promise.resolve({ disk: null })
  }
  return current.bounded.then((value) => ({ disk: value }))
}

/** Mirrors the discard IPC's admission, so the notice never counts a tab Memory Saver would keep. */
function canMemorySaverFree(pageId: string): boolean {
  if (browserManager.isGuestMemoryProtected(pageId)) {
    return false
  }
  const guestId = browserManager.getGuestWebContentsId(pageId)
  const guest = guestId === null ? undefined : webContents.fromId(guestId)
  return (
    !!guest &&
    readBrowserGuestDiscardAdmission(guest, true).protection === 'discardable' &&
    canReserveBrowserPageDiscard(pageId, guest)
  )
}

/** Asked only when the hidden-tabs notice could show, so idle reads never touch browser state. */
export function countHiddenBrowserPages(hiddenForMs: number): number {
  return Number.isFinite(hiddenForMs) && hiddenForMs > 0
    ? getBrowserPageIdleDiscard().countHiddenLoadedPages(hiddenForMs, canMemorySaverFree)
    : 0
}
