import { statfs } from 'node:fs/promises'
import { powerMonitor } from 'electron'
import type { PerfNoticeSignals } from '../../shared/diagnostics/perf-notice-signals'
import { readInProcessAvailableMemory } from '../memory/host-memory'
import { getBrowserPageIdleDiscard } from '../browser/guest-lifecycle/browser-page-idle-discard'

const DISK_READ_INTERVAL_MS = 10 * 60_000

let disk: { path: string; readAt: number; value: Promise<PerfNoticeSignals['disk']> } | null = null

async function statDisk(path: string): Promise<PerfNoticeSignals['disk']> {
  try {
    const stats = await statfs(path)
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
  } catch {
    // A missing or unmounted workspace folder has nothing to warn about.
    return null
  }
}

/** Cached for 10 minutes; concurrent callers share one statfs, even while it is slow. */
function readDiskFree(path: string, now: number): Promise<PerfNoticeSignals['disk']> {
  if (!disk || disk.path !== path || now - disk.readAt >= DISK_READ_INTERVAL_MS) {
    disk = { path, readAt: now, value: statDisk(path) }
  }
  return disk.value
}

/** In-process reads only: no subprocess, and nothing runs unless the renderer asks. */
export async function readPerfNoticeSignals(workspaceDir: string): Promise<PerfNoticeSignals> {
  const [memory, diskValue] = await Promise.all([
    readInProcessAvailableMemory(),
    readDiskFree(workspaceDir, Date.now())
  ])
  return { userIdleSeconds: powerMonitor.getSystemIdleTime(), memory, disk: diskValue }
}

/** Asked only when the hidden-tabs notice could show, so idle reads never touch browser state. */
export function countHiddenBrowserPages(hiddenForMs: number): number {
  return Number.isFinite(hiddenForMs) && hiddenForMs > 0
    ? getBrowserPageIdleDiscard().countHiddenLoadedPages(hiddenForMs)
    : 0
}
