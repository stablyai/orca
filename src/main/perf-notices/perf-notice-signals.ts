import { opendir, statfs } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import {
  isDiskAlmostFull,
  type PerfNoticeDisk,
  type PerfNoticeSignals
} from '../../shared/diagnostics/perf-notice-signals'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { Repo } from '../../shared/repository/repo-types'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { getBrowserPageIdleDiscard } from '../browser/guest-lifecycle/browser-page-idle-discard'
import {
  computeWorkspaceRoot,
  getWorktreePathSettings,
  hasRepoWorktreeBasePath,
  workspaceRootMirrorsIntoWsl
} from '../ipc/worktrees/paths/worktree-logic'
import { getWorktreeMirrorDistro } from '../workspaces/execution-host/project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from '../workspaces/execution-host/local-project-runtime-resolution'
import { wslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'

const DISK_READ_INTERVAL_MS = 10 * 60_000
const DISK_READ_DEADLINE_MS = 15_000

type PerfNoticeSignalStore = Omit<ProjectRuntimeResolutionStore, 'getSettings'> & {
  getSettings: () => Pick<
    GlobalSettings,
    'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'
  > &
    ReturnType<NonNullable<ProjectRuntimeResolutionStore['getSettings']>>
  getRepos: () => Repo[]
}

type DiskRoot = { path: string; earlier: boolean }

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

function isAbsoluteAnywhere(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

/** Where local worktrees live, resolved per repo as creation does, so relative and per-repo
 *  folders point at their real volumes. Current folders come first, then earlier ones that may
 *  still hold workspaces. WSL roots are skipped: reading them can wake a distro. */
function localWorktreeRoots(store: PerfNoticeSignalStore): DiskRoot[] {
  const settings = store.getSettings()
  const history = settings.workspaceDirHistory ?? []
  const relativeHistory = history.filter((layout) => !isAbsoluteAnywhere(layout.path))
  const roots = new Map<string, DiskRoot>()
  const add = (path: string, earlier: boolean): void => {
    const key = normalizeRuntimePathForComparison(path)
    if (!roots.has(key) && !wslDistroForPath(path)) {
      roots.set(key, { path, earlier })
    }
  }
  const earlierRoots: string[] = []
  for (const repo of store.getRepos()) {
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
      continue
    }
    const mirrorDistro =
      process.platform === 'win32' ? getWorktreeMirrorDistro(store, repo) : undefined
    const pathSettings = getWorktreePathSettings(repo, settings, mirrorDistro)
    if (workspaceRootMirrorsIntoWsl(repo.path, pathSettings)) {
      continue
    }
    add(computeWorkspaceRoot(repo.path, pathSettings), false)
    // Why: a root that would mirror into WSL needs a blocking wsl.exe probe to resolve.
    const addEarlier = (workspaceDir: string): void => {
      if (!workspaceRootMirrorsIntoWsl(repo.path, { workspaceDir })) {
        earlierRoots.push(computeWorkspaceRoot(repo.path, { workspaceDir }))
      }
    }
    if (hasRepoWorktreeBasePath(repo)) {
      // Workspaces made before the repo got its own folder stay in the global one.
      addEarlier(settings.workspaceDir)
    }
    for (const layout of relativeHistory) {
      addEarlier(layout.path)
    }
  }
  if (roots.size > 0) {
    for (const layout of history) {
      if (isAbsoluteAnywhere(layout.path)) {
        earlierRoots.push(layout.path)
      }
    }
  }
  for (const path of earlierRoots) {
    add(path, true)
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

/** An earlier folder counts only while it still holds something cleanup could remove. */
async function hasEntries(path: string): Promise<boolean> {
  try {
    const dir = await opendir(path)
    try {
      return (await dir.read()) !== null
    } finally {
      await dir.close()
    }
  } catch {
    return false
  }
}

async function readRoot(root: DiskRoot): Promise<PerfNoticeDisk | null> {
  if (root.earlier && !(await hasEntries(root.path))) {
    return null
  }
  return statDisk(root.path)
}

async function readFullestDisk(roots: DiskRoot[]): Promise<PerfNoticeDisk | null> {
  let first: PerfNoticeDisk | null = null
  for (const root of roots) {
    if (callInFlight) {
      return first
    }
    callInFlight = true
    let disk: PerfNoticeDisk | null
    try {
      disk = await readRoot(root)
    } finally {
      callInFlight = false
    }
    if (isDiskAlmostFull(disk)) {
      return disk
    }
    first ??= disk
  }
  return first
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
  const key = roots.map((root) => root.path).join('\0')
  const now = Date.now()
  let current = disk
  const stale = !current || current.key !== key || now - current.readAt >= DISK_READ_INTERVAL_MS
  if (!current || (stale && current.settled)) {
    const read = { key, readAt: now, settled: false, bounded: withDeadline(readFullestDisk(roots)) }
    void read.bounded.finally(() => {
      read.settled = true
    })
    current = disk = read
  }
  // Why: a read under way for roots the user has since changed says nothing about the new ones.
  if (current.key !== key) {
    return Promise.resolve({ disk: null })
  }
  return current.bounded.then((value) => ({ disk: value }))
}

/** Asked only when the hidden-tabs notice could show, so idle reads never touch browser state. */
export function countHiddenBrowserPages(hiddenForMs: number): number {
  return Number.isFinite(hiddenForMs) && hiddenForMs > 0
    ? getBrowserPageIdleDiscard().countHiddenLoadedPages(hiddenForMs)
    : 0
}
