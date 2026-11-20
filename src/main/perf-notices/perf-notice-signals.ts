import { statfs } from 'node:fs/promises'
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
  workspaceRootMirrorsIntoWsl
} from '../ipc/worktrees/paths/worktree-logic'
import { getWorktreeMirrorDistro } from '../workspaces/execution-host/project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from '../workspaces/execution-host/local-project-runtime-resolution'
import { wslDistroForPath } from '../wsl/filesystem/wsl-unc-access-gate'
import { buildKnownOrcaWorkspaceLayouts } from '../../shared/worktree/visibility/ownership'

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

let disk: {
  key: string
  readAt: number
  settled: boolean
  value: Promise<PerfNoticeDisk | null>
} | null = null

/** Where local worktrees live, resolved per repo as creation does, so relative, per-repo and
 *  earlier folders point at their real volumes. WSL roots are skipped: reading them can wake a distro. */
function localWorktreeRoots(store: PerfNoticeSignalStore): string[] {
  const settings = store.getSettings()
  const roots = new Set<string>()
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
    // Earlier workspace folders still hold workspaces until they are cleaned up.
    const known = buildKnownOrcaWorkspaceLayouts(settings, repo).map((layout) => layout.path)
    for (const root of [computeWorkspaceRoot(repo.path, pathSettings), ...known]) {
      if (!wslDistroForPath(root)) {
        roots.add(root)
      }
    }
  }
  return [...roots]
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

/** One statfs at a time: a hung network mount then holds one libuv thread, not one per repo. */
async function readFullestDisk(roots: string[]): Promise<PerfNoticeDisk | null> {
  let first: PerfNoticeDisk | null = null
  for (const root of roots) {
    const disk = await statDisk(root)
    if (isDiskAlmostFull(disk)) {
      return disk
    }
    first ??= disk
  }
  return first
}

/** Cached for 10 minutes per set of roots; concurrent callers share one read, and a read still
 *  pending (a hung mount) is never stacked with another. */
export function readPerfNoticeSignals(store: PerfNoticeSignalStore): Promise<PerfNoticeSignals> {
  const roots = localWorktreeRoots(store)
  const key = roots.join('\0')
  const now = Date.now()
  let current = disk
  const stale = !current || current.key !== key || now - current.readAt >= DISK_READ_INTERVAL_MS
  if (!current || (stale && current.settled)) {
    const read = { key, readAt: now, settled: false, value: readFullestDisk(roots) }
    void read.value.finally(() => {
      read.settled = true
    })
    current = disk = read
  }
  // Why: a pending read for roots the user has since changed says nothing about the new ones.
  if (current.key !== key) {
    return Promise.resolve({ disk: null })
  }
  return withDeadline(current.value).then((value) => ({ disk: value }))
}

/** A hung mount answers "no reading" so the notice loop moves on; the read itself stays pending,
 *  so no second one starts behind it. */
function withDeadline(read: Promise<PerfNoticeDisk | null>): Promise<PerfNoticeDisk | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DISK_READ_DEADLINE_MS)
  })
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer))
}

/** Asked only when the hidden-tabs notice could show, so idle reads never touch browser state. */
export function countHiddenBrowserPages(hiddenForMs: number): number {
  return Number.isFinite(hiddenForMs) && hiddenForMs > 0
    ? getBrowserPageIdleDiscard().countHiddenLoadedPages(hiddenForMs)
    : 0
}
