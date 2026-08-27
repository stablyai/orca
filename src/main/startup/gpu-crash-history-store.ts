import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  GpuCrashHistoryEntry,
  GpuCrashHistoryLaunch
} from '../crash-reporting/gpu-crash-fallback-decision'
import type { GpuFallbackEnvironment } from './gpu-fallback-marker'

/**
 * Build-scoped ring of GPU child crashes, stored next to the GPU fallback marker.
 *
 * Why on disk: a GPU fault that kills the app leaves the in-memory tracker empty
 * on the next launch, so a "crash once per launch, forever" loop never reaches
 * the in-launch burst threshold. Timestamps are wall clock — performance.now()
 * restarts at 0 every launch and cannot be compared across them.
 */

export const GPU_CRASH_HISTORY_FILE = 'gpu-crash-history.json'
export const GPU_CRASH_HISTORY_SCHEME_VERSION = 1
/** Deep enough for the streak + window rules, small enough to write synchronously. */
export const GPU_CRASH_HISTORY_MAX_ENTRIES = 16

type GpuCrashHistoryFile = {
  schemeVersion: number
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
  launchSeq: number
  entries: GpuCrashHistoryEntry[]
  /** Wall clock of the last "Keep Running" answer; null when never declined. */
  declinedAt: number | null
}

function historyPath(userDataPath: string): string {
  return join(userDataPath, GPU_CRASH_HISTORY_FILE)
}

function isValidEntry(value: unknown): value is GpuCrashHistoryEntry {
  const entry = value as Partial<GpuCrashHistoryEntry> | null
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.ts === 'number' &&
    Number.isFinite(entry.ts) &&
    (entry.exitCode === null || typeof entry.exitCode === 'number') &&
    typeof entry.launchSeq === 'number' &&
    Number.isFinite(entry.launchSeq)
  )
}

export function readGpuCrashHistory(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): GpuCrashHistoryFile | null {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(userDataPath), 'utf-8')) as Partial<
      Record<keyof GpuCrashHistoryFile, unknown>
    >
    if (
      parsed.schemeVersion !== GPU_CRASH_HISTORY_SCHEME_VERSION ||
      parsed.appVersion !== environment.appVersion ||
      parsed.electronVersion !== environment.electronVersion ||
      parsed.platform !== environment.platform ||
      typeof parsed.launchSeq !== 'number' ||
      !Number.isFinite(parsed.launchSeq) ||
      !Array.isArray(parsed.entries)
    ) {
      // Why: a different build (or a corrupt file) gets a clean slate — the
      // evidence describes a driver/binary pairing that no longer exists.
      return null
    }
    return {
      schemeVersion: GPU_CRASH_HISTORY_SCHEME_VERSION,
      appVersion: environment.appVersion,
      electronVersion: environment.electronVersion,
      platform: environment.platform,
      launchSeq: parsed.launchSeq,
      entries: parsed.entries.filter(isValidEntry).slice(-GPU_CRASH_HISTORY_MAX_ENTRIES),
      declinedAt:
        typeof parsed.declinedAt === 'number' && Number.isFinite(parsed.declinedAt)
          ? parsed.declinedAt
          : null
    }
  } catch {
    // missing or unreadable means no history
  }
  return null
}

function writeGpuCrashHistory(userDataPath: string, file: GpuCrashHistoryFile): void {
  try {
    const target = historyPath(userDataPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(file))
  } catch {
    // best effort: losing history only costs a slower fallback decision
  }
}

export function clearGpuCrashHistory(userDataPath: string): void {
  try {
    rmSync(historyPath(userDataPath), { force: true })
  } catch {
    // best effort; the next launch revalidates the file anyway
  }
}

/**
 * Claims the next launch sequence number and hands back an append port.
 *
 * Called once per launch even when no GPU crash follows: a crash-free launch has
 * to bump the counter, otherwise a gap in the sequence — the only evidence that
 * the streak broke — would never be recorded.
 */
export function openGpuCrashHistoryLaunch(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): GpuCrashHistoryLaunch {
  const existing = readGpuCrashHistory(userDataPath, environment)
  const launchSeq = (existing?.launchSeq ?? 0) + 1
  let entries = existing?.entries ?? []
  let declinedAt = existing?.declinedAt ?? null
  const file: GpuCrashHistoryFile = {
    schemeVersion: GPU_CRASH_HISTORY_SCHEME_VERSION,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: environment.platform,
    launchSeq,
    entries,
    declinedAt
  }
  writeGpuCrashHistory(userDataPath, file)
  return {
    launchSeq,
    // Getter, not a snapshot: a decline taken mid-launch must be visible at once.
    get declinedAt() {
      return declinedAt
    },
    append: (crash) => {
      entries = [...entries, { ts: crash.ts, exitCode: crash.exitCode, launchSeq }].slice(
        -GPU_CRASH_HISTORY_MAX_ENTRIES
      )
      writeGpuCrashHistory(userDataPath, { ...file, entries, declinedAt })
      return entries
    },
    noteRestartDeclined: (at) => {
      declinedAt = at
      writeGpuCrashHistory(userDataPath, { ...file, entries, declinedAt })
    }
  }
}
