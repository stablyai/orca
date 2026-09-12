import type { WebContents } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

// Why: #14552's six agent-opened headless tabs hid one 1.3 GB renderer, and a page count alone
// could not show it. Same polling discipline as serve-stats-host.ts: one `/proc/<pid>/status` read
// per distinct renderer pid (a memory-backed file, no disk I/O), never a subprocess and never
// `collectMemorySnapshot`'s `ps` process-table sweep, so `serve stats` stays cheap to poll.

const KIB = 1024

/** Injection seam: lets the non-Linux and pid-gone paths be proven on a Linux host. */
export type ServeStatsBrowserPageMemorySources = {
  platform?: NodeJS.Platform
  /** The renderer's OS pid for one registered page, or null when the WebContents is gone. */
  osProcessId?: (webContentsId: number) => number | null
  /** Raw `/proc/<pid>/status` text, or null when that pid has no readable procfs entry. */
  readProcStatus?: (pid: number) => string | null
}

export type ServeStatsBrowserPageMemory = {
  totalBytes: number | null
  maxBytes: number | null
}

export type ServeStatsBrowserPageBridge = {
  getRegisteredTabs?: (worktreeId?: string) => ReadonlyMap<string, number>
}

export type ServeStatsBrowserPages = {
  /** Every page of both kinds, de-duplicated by page id. */
  total: number
  /** The client-hosted subset whose host is gone. */
  retained: number
  memory: ServeStatsBrowserPageMemory
}

/**
 * The browser-page population this runtime holds, plus the renderer footprint behind it.
 *
 * Why one pass: the registry only ever holds client-hosted pages, so counting it alone reported 0
 * for every page a headless serve opens — the offscreen population #14552 is actually about. Those
 * pages are keyed by id in the WebContents registration map the bridge reads, which is also the
 * only handle a footprint read can start from, so both come off the same walk.
 *
 * `getRegisteredTabs` and never `tabList`: listing sweeps dead guests out of BrowserManager, and a
 * stats read must deregister nothing. Both the bridge and that method are optional-called, like
 * every other bridge read in the runtime: the bridge is injected, so a caller may hold one that
 * predates this collector.
 */
export function collectServeStatsBrowserPages(
  runtime: Parameters<typeof getBrowserHostLeaseRegistry>[0],
  bridge: ServeStatsBrowserPageBridge | null | undefined,
  sources: ServeStatsBrowserPageMemorySources = {}
): ServeStatsBrowserPages {
  const leases = getBrowserHostLeaseRegistry(runtime)
  const pageRegistry = getRuntimeBrowserPageRegistry(runtime)
  const clientPages = pageRegistry.countPages(
    (browserPageId) => leases.getPlacement(browserPageId) !== undefined
  )
  let hostBackedPages = 0
  const rendererWebContentsIds: number[] = []
  for (const [browserPageId, webContentsId] of bridge?.getRegisteredTabs?.() ?? []) {
    rendererWebContentsIds.push(webContentsId)
    if (!pageRegistry.getPage(browserPageId)) {
      hostBackedPages++
    }
  }
  return {
    total: clientPages.total + hostBackedPages,
    // Retention is a client-hosted notion only: a WebContents-backed page has no separate host to
    // lose, so counting one here would misreport a leak.
    retained: clientPages.retained,
    memory: collectServeStatsBrowserPageMemory(rendererWebContentsIds, sources)
  }
}

/**
 * Resident-set total and single-largest footprint across the renderer processes backing
 * `webContentsIds`, both null when nothing here was measurable.
 *
 * De-duplicated by pid: Electron may back several pages with one renderer, and summing per page
 * would count that process once per page it hosts. `maxBytes` is therefore the largest renderer,
 * which is the granularity the outlier actually lives at.
 *
 * Null and not 0 for "no measurement" — including an empty page set, where a 0 total would claim a
 * measured, idle renderer population. `counts.browserPages` is what distinguishes "no pages" from
 * "pages this platform cannot measure".
 */
export function collectServeStatsBrowserPageMemory(
  webContentsIds: Iterable<number>,
  sources: ServeStatsBrowserPageMemorySources = {}
): ServeStatsBrowserPageMemory {
  if ((sources.platform ?? process.platform) !== 'linux') {
    return { totalBytes: null, maxBytes: null }
  }
  const osProcessId = sources.osProcessId ?? readOsProcessId
  const readProcStatus = sources.readProcStatus ?? readProcStatusFile
  const measured = new Map<number, number>()
  for (const webContentsId of webContentsIds) {
    const pid = osProcessId(webContentsId)
    if (pid === null || measured.has(pid)) {
      continue
    }
    const status = readProcStatus(pid)
    const rss = status === null ? null : parseProcStatusVmRssBytes(status)
    if (rss !== null) {
      measured.set(pid, rss)
    }
  }
  if (measured.size === 0) {
    return { totalBytes: null, maxBytes: null }
  }
  let totalBytes = 0
  let maxBytes = 0
  for (const rss of measured.values()) {
    totalBytes += rss
    maxBytes = Math.max(maxBytes, rss)
  }
  return { totalBytes, maxBytes }
}

/** `VmRSS` in bytes from `/proc/<pid>/status`, or null when the line is absent or unparseable. */
export function parseProcStatusVmRssBytes(status: string): number | null {
  const match = /^VmRSS:\s*(\d+)\s+kB$/m.exec(status)
  if (!match) {
    return null
  }
  const kib = Number(match[1])
  return Number.isFinite(kib) ? kib * KIB : null
}

// Why `require` in a try, matching AgentBrowserBridgeState.getWebContents: this module is reachable
// from a `serve stats` read in unit tests where electron is mocked down to `app`, and a missing
// `webContents` must read as "not measurable" rather than throwing out of the stats call. The
// module shape is declared locally for the same reason — the real `electron` types are not what a
// mocked runtime actually hands back.
type ElectronWebContentsModule = {
  webContents?: {
    fromId?: (webContentsId: number) => WebContents | null
  }
}

function readOsProcessId(webContentsId: number): number | null {
  try {
    const { webContents } = require('electron') as ElectronWebContentsModule
    const target = webContents?.fromId?.(webContentsId)
    if (!target || target.isDestroyed()) {
      return null
    }
    const pid = target.getOSProcessId()
    return typeof pid === 'number' && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function readProcStatusFile(pid: number): string | null {
  try {
    return readFileSync(path.join(path.sep, 'proc', String(pid), 'status'), 'utf8')
  } catch {
    // The renderer exited between the registration read and this one: not measurable, not 0.
    return null
  }
}
