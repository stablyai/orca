import { statfs } from 'node:fs/promises'
import { powerMonitor } from 'electron'
import type { PerfNoticeSignals } from '../../shared/diagnostics/perf-notice-signals'
import { readInProcessAvailableMemory } from '../memory/host-memory'
import { getBrowserPageIdleDiscard } from '../browser/guest-lifecycle/browser-page-idle-discard'

const DISK_READ_INTERVAL_MS = 10 * 60_000
const HIDDEN_PAGE_MIN_MS = 4 * 60 * 60_000

let disk: { path: string; readAt: number; value: PerfNoticeSignals['disk'] } | null = null

async function readDiskFree(path: string, now: number): Promise<PerfNoticeSignals['disk']> {
  if (disk && disk.path === path && now - disk.readAt < DISK_READ_INTERVAL_MS) {
    return disk.value
  }
  let value: PerfNoticeSignals['disk'] = null
  try {
    const stats = await statfs(path)
    value = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
  } catch {
    // A missing or unmounted workspace folder has nothing to warn about.
  }
  disk = { path, readAt: now, value }
  return value
}

/** In-process reads only: no subprocess, and nothing runs unless the renderer asks. */
export async function readPerfNoticeSignals(workspaceDir: string): Promise<PerfNoticeSignals> {
  const now = Date.now()
  const [memory, diskValue] = await Promise.all([
    readInProcessAvailableMemory(),
    readDiskFree(workspaceDir, now)
  ])
  return {
    userIdleSeconds: powerMonitor.getSystemIdleTime(),
    memory,
    disk: diskValue,
    hiddenBrowserPages: getBrowserPageIdleDiscard().countHiddenLoadedPages(HIDDEN_PAGE_MIN_MS)
  }
}
