// Answers one question the crash report could never answer before: did the main
// process that recorded the previous session's reports exit, or was it killed?
// The evidence is the durable-breadcrumb trail already in the NDJSON trace file — a
// launch whose crumbs carry the schema marker but no `main_process_quit_committed`
// died abruptly. Without the marker the launch is named and left unjudged.

import { open } from 'node:fs/promises'
import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { listRotatedFiles } from '../observability/local-file-sink'
import { getTraceFilePath } from '../observability/logs-directory'
import { readLinesNewestFirst } from '../observability/ndjson-line-scan'
import { COMMITTED_QUIT_BREADCRUMB_NAME } from './committed-quit-breadcrumb'
import type { CrashReportStore } from './crash-report-store'
import { DURABLE_CRASH_BREADCRUMB_SCHEMA } from './durable-crash-breadcrumb'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'

export type PreviousLaunchExit = {
  previousLaunchId: string
  /** Undefined when the previous launch ran a build that never wrote the quit crumb:
   *  its absence is then no evidence of an abrupt death, and saying so would fabricate
   *  one for every user's first launch after upgrading to this build. */
  diedAbruptly?: boolean
}

const BREADCRUMB_SPAN_NAME = 'crash.breadcrumb'
/** Enough tail to hold a launch's closing crumbs without reading a 10 MB file. */
const TRACE_TAIL_BYTES = 512 * 1024
/** The newest file plus the one rotation a launch boundary can fall across. */
const TRACE_FILES_SCANNED = 2
// Why bounded yet conclusive: the quit crumb is written the moment quit commits, so
// only teardown-time crumbs can follow it. Its absence from a launch's newest crumbs
// is its absence from the launch.
const PREVIOUS_LAUNCH_CRUMB_SCAN_LIMIT = 200

type TracedBreadcrumb = { name: string; launchId: string; writesQuitCrumb: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function tracedBreadcrumb(line: string): TracedBreadcrumb | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // A tail read starts mid-line, and a killed process leaves a half-line.
    return null
  }
  if (!isRecord(parsed) || parsed.name !== BREADCRUMB_SPAN_NAME) {
    return null
  }
  const attributes = parsed.attributes
  if (!isRecord(attributes)) {
    return null
  }
  const name = attributes['breadcrumb.name']
  const data = attributes['breadcrumb.data']
  const launchId = isRecord(data) ? data.mainProcessLaunchId : undefined
  if (typeof name !== 'string' || typeof launchId !== 'string' || !launchId) {
    return null
  }
  return {
    name,
    launchId,
    writesQuitCrumb: attributes['breadcrumb.schema'] === DURABLE_CRASH_BREADCRUMB_SCHEMA
  }
}

/** Scans a trace tail newest-first for the launch that preceded `currentLaunchId`.
 *  Returns null when no other launch left a breadcrumb in the tail. */
export function findPreviousLaunchExit(
  traceTail: string,
  currentLaunchId: string
): PreviousLaunchExit | null {
  let previousLaunchId: string | undefined
  let previousLaunchWritesQuitCrumb = false
  let scanned = 0
  for (const line of readLinesNewestFirst(traceTail)) {
    const crumb = tracedBreadcrumb(line)
    if (!crumb || crumb.launchId === currentLaunchId) {
      continue
    }
    if (previousLaunchId === undefined) {
      previousLaunchId = crumb.launchId
    } else if (crumb.launchId !== previousLaunchId) {
      break
    }
    previousLaunchWritesQuitCrumb ||= crumb.writesQuitCrumb
    if (crumb.name === COMMITTED_QUIT_BREADCRUMB_NAME) {
      return { previousLaunchId, diedAbruptly: false }
    }
    scanned += 1
    if (scanned >= PREVIOUS_LAUNCH_CRUMB_SCAN_LIMIT) {
      break
    }
  }
  if (previousLaunchId === undefined) {
    return null
  }
  // Named but not judged: a launch whose crumbs predate the schema marker ran a build
  // that had no quit crumb to write, so nothing here separates a kill from a clean quit.
  return previousLaunchWritesQuitCrumb
    ? { previousLaunchId, diedAbruptly: true }
    : { previousLaunchId }
}

async function readTraceTail(filePath: string, maxBytes: number): Promise<string | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    if (length <= 0) {
      return null
    }
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

export async function loadPreviousLaunchExit(
  currentLaunchId: string,
  traceFilePaths: string[]
): Promise<PreviousLaunchExit | null> {
  for (const filePath of traceFilePaths) {
    const tail = await readTraceTail(filePath, TRACE_TAIL_BYTES)
    if (tail === null) {
      continue
    }
    const exit = findPreviousLaunchExit(tail, currentLaunchId)
    if (exit) {
      return exit
    }
  }
  return null
}

let previousLaunchExit: PreviousLaunchExit | null = null

/** Reports this session records name the previous launch's fate, so an abrupt
 *  whole-app death is visible even in the run that followed it. */
export function previousLaunchExitDetails(): Record<string, CrashReportDetailValue> {
  if (!previousLaunchExit) {
    return {}
  }
  return {
    previousMainProcessLaunchId: previousLaunchExit.previousLaunchId,
    ...(previousLaunchExit.diedAbruptly === undefined
      ? {}
      : { previousMainProcessDiedAbruptly: previousLaunchExit.diedAbruptly })
  }
}

/** Backfills the reports the dead launch itself recorded — the ones a triager
 *  actually opens, whose post-death process census reads as "the browser survived". */
export async function annotateAbruptlyEndedLaunchReports(
  store: Pick<CrashReportStore, 'listRecent' | 'attachDetails'>,
  exit: PreviousLaunchExit | null = previousLaunchExit
): Promise<void> {
  if (!exit?.diedAbruptly) {
    return
  }
  for (const report of await store.listRecent()) {
    if (
      report.details.mainProcessLaunchId !== exit.previousLaunchId ||
      report.details.mainProcessDiedAbruptly === true
    ) {
      continue
    }
    await store.attachDetails(report.id, { mainProcessDiedAbruptly: true })
  }
}

/** Startup entry point: resolve the previous launch's fate, then stamp it onto the
 *  reports it left behind. Diagnostics only — never fails a launch. */
export async function initPreviousLaunchExitVerdict(
  store: Pick<CrashReportStore, 'listRecent' | 'attachDetails'> | null
): Promise<void> {
  try {
    previousLaunchExit = await loadPreviousLaunchExit(
      getMainProcessLifecycleIdentity().mainProcessLaunchId,
      listRotatedFiles(getTraceFilePath(), TRACE_FILES_SCANNED)
    )
    if (store) {
      await annotateAbruptlyEndedLaunchReports(store)
    }
  } catch (error) {
    console.warn('[crash-reporting] previous-launch exit verdict unavailable:', error)
  }
}

export function setPreviousLaunchExitForTest(exit: PreviousLaunchExit | null): void {
  previousLaunchExit = exit
}
