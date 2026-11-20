import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
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

const DISK_READ_INTERVAL_MS = 10 * 60_000

type PerfNoticeSignalStore = Omit<ProjectRuntimeResolutionStore, 'getSettings'> & {
  getSettings: () => Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'> &
    ReturnType<NonNullable<ProjectRuntimeResolutionStore['getSettings']>>
  getRepos: () => Repo[]
}

let disk: { key: string; readAt: number; value: Promise<PerfNoticeDisk | null> } | null = null

/** Where local worktrees land, resolved per repo as creation does, so relative and per-repo
 *  folders point at their real volumes. WSL roots are skipped: reading them can wake a distro. */
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
    const root = computeWorkspaceRoot(repo.path, pathSettings)
    if (!wslDistroForPath(root)) {
      roots.add(root)
    }
  }
  return [...roots]
}

/** A root not created yet still lives on its nearest existing parent's volume. */
async function statDisk(path: string): Promise<PerfNoticeDisk | null> {
  for (let current = path; ; current = dirname(current)) {
    try {
      const stats = await statfs(current)
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
    } catch {
      if (dirname(current) === current) {
        // An unmounted or unreadable folder has nothing to warn about.
        return null
      }
    }
  }
}

async function readFullestDisk(roots: string[]): Promise<PerfNoticeDisk | null> {
  const disks = (await Promise.all(roots.map(statDisk))).filter((d): d is PerfNoticeDisk => !!d)
  return disks.find(isDiskAlmostFull) ?? disks[0] ?? null
}

/** Cached for 10 minutes per set of roots; concurrent callers share one read, even while it is slow. */
export function readPerfNoticeSignals(store: PerfNoticeSignalStore): Promise<PerfNoticeSignals> {
  const roots = localWorktreeRoots(store)
  const key = roots.join('\0')
  const now = Date.now()
  if (!disk || disk.key !== key || now - disk.readAt >= DISK_READ_INTERVAL_MS) {
    disk = { key, readAt: now, value: readFullestDisk(roots) }
  }
  return disk.value.then((value) => ({ disk: value }))
}

/** Asked only when the hidden-tabs notice could show, so idle reads never touch browser state. */
export function countHiddenBrowserPages(hiddenForMs: number): number {
  return Number.isFinite(hiddenForMs) && hiddenForMs > 0
    ? getBrowserPageIdleDiscard().countHiddenLoadedPages(hiddenForMs)
    : 0
}
