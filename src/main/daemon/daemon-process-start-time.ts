import { runProcess, runProcessSync } from '../../shared/child-process/run-process'
import { readFileSync } from 'node:fs'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import { getPsProcessIdentity, getPsProcessIdentityAsync } from './daemon-process-identity-query'

export const START_TIME_TOLERANCE_MS = 1_500

const CLK_TCK_TIMEOUT_MS = 1_000
const CLK_TCK_SPEC = {
  program: 'getconf',
  args: ['CLK_TCK'],
  timeoutMs: CLK_TCK_TIMEOUT_MS
} as const

// CLK_TCK is fixed at kernel build time, so one spawn per process lifetime is
// the whole budget — a liveness check must never re-fork `getconf`.
let clockTicksPerSecond: number | null = null

function cacheClockTicks(ticks: number): number | null {
  clockTicksPerSecond = Number.isFinite(ticks) && ticks > 0 ? ticks : null
  return clockTicksPerSecond
}

function readClockTicksPerSecond(): number | null {
  if (clockTicksPerSecond !== null) {
    return clockTicksPerSecond
  }
  const result = runProcessSync(CLK_TCK_SPEC)
  return result.code === 0 && !result.timedOut ? cacheClockTicks(Number(result.stdout.trim())) : null
}

async function readClockTicksPerSecondAsync(): Promise<number | null> {
  if (clockTicksPerSecond !== null) {
    return clockTicksPerSecond
  }
  const result = await runProcess(CLK_TCK_SPEC)
  return result.code === 0 && !result.timedOut ? cacheClockTicks(Number(result.stdout.trim())) : null
}

/** Test seam: the cache outlives a `vi.resetModules()`-free test file. */
export function resetProcessStartTimeClockTickCache(): void {
  clockTicksPerSecond = null
}

function linuxStartedAtMs(pid: number, ticksPerSecond: number | null): number | null {
  if (ticksPerSecond === null) {
    return null
  }
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const startTicks = parseLinuxProcStartTicks(stat)
  const bootTimeSeconds = parseLinuxBootTimeSeconds(readFileSync('/proc/stat', 'utf8'))
  if (!Number.isFinite(startTicks) || !Number.isFinite(bootTimeSeconds)) {
    return null
  }
  return bootTimeSeconds * 1000 + (startTicks / ticksPerSecond) * 1000
}

function getLinuxProcessStartedAtMs(pid: number): number | null {
  try {
    return linuxStartedAtMs(pid, readClockTicksPerSecond())
  } catch {
    return null
  }
}

async function getLinuxProcessStartedAtMsAsync(pid: number): Promise<number | null> {
  try {
    return linuxStartedAtMs(pid, await readClockTicksPerSecondAsync())
  } catch {
    return null
  }
}

export function parseLinuxProcStartTicks(stat: string): number {
  const commandEndIndex = stat.lastIndexOf(')')
  if (commandEndIndex === -1) {
    return Number.NaN
  }

  const fields = getProcessOutputFields(stat.slice(commandEndIndex + 1), 20)
  return Number(fields[19])
}

export function parseLinuxBootTimeSeconds(procStat: string): number {
  for (const line of iterateProcessOutputLines(procStat)) {
    if (!line.startsWith('btime ')) {
      continue
    }
    return Number(getProcessOutputFields(line, 2)[1])
  }
  return Number.NaN
}

export function getProcessStartedAtMs(pid: number): number | null {
  if (process.platform === 'linux') {
    return getLinuxProcessStartedAtMs(pid)
  }

  if (process.platform === 'win32') {
    // Why: the only OS source is a CIM query costing a powershell spawn —
    // too slow for this sync path. Windows pid files instead carry the
    // daemon's self-reported start time from its ready message, and
    // isDaemonProcess verifies it against CIM CreationDate asynchronously.
    return null
  }

  return getPsProcessIdentity(pid)?.startedAtMs ?? null
}

export function startTimeMatches(pid: number, expectedStartedAtMs: number | null): boolean {
  return startTimesWithinTolerance(
    getProcessStartedAtMs(pid),
    expectedStartedAtMs,
    START_TIME_TOLERANCE_MS
  )
}

/**
 * Async twins, for the callers already on a promise — the daemon identity
 * inspection an `ipcMain` reply waits on. A timeout still yields `null`, which
 * `startTimesWithinTolerance` fails open on: loss of contact never becomes a
 * start-time mismatch.
 */
export async function getProcessStartedAtMsAsync(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    return getLinuxProcessStartedAtMsAsync(pid)
  }
  if (process.platform === 'win32') {
    return null
  }
  return (await getPsProcessIdentityAsync(pid))?.startedAtMs ?? null
}

export async function startTimeMatchesAsync(
  pid: number,
  expectedStartedAtMs: number | null
): Promise<boolean> {
  return startTimesWithinTolerance(
    await getProcessStartedAtMsAsync(pid),
    expectedStartedAtMs,
    START_TIME_TOLERANCE_MS
  )
}

// Why: fail open on null — a pid file or OS query without a start time must
// not veto an otherwise-matching daemon (adoption safety beats recycle safety).
export function startTimesWithinTolerance(
  actualStartedAtMs: number | null,
  expectedStartedAtMs: number | null,
  toleranceMs: number
): boolean {
  if (expectedStartedAtMs === null || actualStartedAtMs === null) {
    return true
  }
  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= toleranceMs
}
