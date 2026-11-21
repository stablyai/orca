import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { webContents } from 'electron'
import {
  isDiskAlmostFull,
  type PerfNoticeDisk,
  type PerfNoticeSignals
} from '../../shared/diagnostics/perf-notice-signals'
import {
  isRepoOnCatalogHost,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../shared/file-access/cross-platform-path'
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
const ROOT_READ_DEADLINE_MS = 5_000
/** Calls a dead mount may hold at once; the rest of libuv's pool (4 by default) stays free. */
const MAX_STALLED_READS = 2

type PerfNoticeSignalStore = Omit<ProjectRuntimeResolutionStore, 'getSettings'> & {
  getSettings: () => Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'> &
    ReturnType<NonNullable<ProjectRuntimeResolutionStore['getSettings']>>
  getRepos: () => Repo[]
  getAllWorktreeMetaForHost: (
    executionHostId: typeof LOCAL_EXECUTION_HOST_ID
  ) => Record<string, { archivedCheckout?: unknown }>
}

/** Roots whose filesystem call is still running. A stalled root is skipped, not re-read, so a dead
 *  mount holds one libuv thread while other disks keep their readings. */
const pendingRoots = new Set<string>()

let disk: {
  key: string
  readAt: number
  settled: boolean
  /** Shared by every caller, so a hung read gains no handlers per check. */
  bounded: Promise<PerfNoticeDisk | null>
} | null = null

/** The folders whose disks hold local workspaces: where each project creates new ones (resolved as
 *  creation does), then the folder of each workspace outside those, e.g. from before the workspace
 *  folder moved. One root per folder, so the reads stay flat in workspace count.
 *  WSL roots are skipped: resolving or reading them can wake a distro. */
function localWorktreeRoots(store: PerfNoticeSignalStore): string[] {
  // Why: only rows whose files provably live here, matching what local cleanup owns.
  const repos = store.getRepos().filter((repo) => isRepoOnCatalogHost(repo) && !isFolderRepo(repo))
  if (repos.length === 0) {
    return []
  }
  const settings = store.getSettings()
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
  const insideRoot = [...roots.values()].map(createNormalizedPathInsideOrEqualMatcher)
  // Why: this machine's rows only; remote hosts can reuse a repo id for their own paths.
  const metaById = store.getAllWorktreeMetaForHost(LOCAL_EXECUTION_HOST_ID)
  for (const [worktreeId, meta] of Object.entries(metaById)) {
    const parsed = splitWorktreeId(worktreeId)
    const checkout = parsed ? checkoutByRepoId.get(parsed.repoId) : undefined
    if (!parsed || checkout === undefined || meta.archivedCheckout) {
      continue
    }
    const worktreePath = normalizeRuntimePathForComparison(parsed.worktreePath)
    if (worktreePath !== checkout && !insideRoot.some((inside) => inside(worktreePath))) {
      add(dirname(parsed.worktreePath))
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

/** One root at a time; a root slower than its deadline keeps running alone while the rest are read. */
async function readFullestDisk(roots: string[]): Promise<PerfNoticeDisk | null> {
  let first: PerfNoticeDisk | null = null
  for (const root of roots) {
    const key = normalizeRuntimePathForComparison(root)
    if (pendingRoots.has(key)) {
      continue
    }
    if (pendingRoots.size >= MAX_STALLED_READS) {
      break
    }
    pendingRoots.add(key)
    const read = statDisk(root).finally(() => pendingRoots.delete(key))
    const disk = await withDeadline(read, ROOT_READ_DEADLINE_MS)
    if (isDiskAlmostFull(disk)) {
      return disk
    }
    first ??= disk
  }
  return first
}

/** A hung mount answers "no reading" so the notice loop moves on. */
function withDeadline(
  read: Promise<PerfNoticeDisk | null>,
  deadlineMs: number
): Promise<PerfNoticeDisk | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs)
  })
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer))
}

/** Cached for 10 minutes per set of roots; concurrent callers share one read until its result
 *  or its deadline. */
export function readPerfNoticeSignals(store: PerfNoticeSignalStore): Promise<PerfNoticeSignals> {
  const roots = localWorktreeRoots(store)
  if (roots.length === 0) {
    return Promise.resolve({ disk: null })
  }
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
      bounded: withDeadline(scan, DISK_READ_DEADLINE_MS)
    }
    void read.bounded.finally(() => {
      read.settled = true
    })
    // Why: a read slower than the deadline still lands in the cache, so the next check uses it.
    void scan.then((result) => {
      if (!disk || disk.key === key) {
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
