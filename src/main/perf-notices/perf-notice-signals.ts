import { statfs } from 'node:fs/promises'
import type { PerfNoticeSignals } from '../../shared/diagnostics/perf-notice-signals'
import { getBrowserPageIdleDiscard } from '../browser/guest-lifecycle/browser-page-idle-discard'
import { collectHostMemory } from '../memory/host-memory'

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
export function readPerfNoticeSignals(workspaceDir: string): Promise<PerfNoticeSignals> {
  const now = Date.now()
  if (!disk || disk.path !== workspaceDir || now - disk.readAt >= DISK_READ_INTERVAL_MS) {
    disk = { path: workspaceDir, readAt: now, value: statDisk(workspaceDir) }
  }
  return disk.value.then((value) => ({ disk: value }))
}

/** Asked only when the hidden-tabs notice could show, so idle reads never touch browser state. */
export function countHiddenBrowserPages(hiddenForMs: number): number {
  return Number.isFinite(hiddenForMs) && hiddenForMs > 0
    ? getBrowserPageIdleDiscard().countHiddenLoadedPages(hiddenForMs)
    : 0
}

/** Asked only while Agent Sleep is off, the one case the low-memory notice can show. */
export async function readAvailableMemoryFraction(): Promise<number | null> {
  const host = await collectHostMemory()
  return host.totalMemory > 0 ? host.availableMemory / host.totalMemory : null
}
