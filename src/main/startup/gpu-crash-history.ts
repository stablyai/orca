import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurableSync
} from '../durable-file-write'
import type { GpuFallbackEnvironment } from './gpu-fallback-marker'

/**
 * Cross-launch record of GPU child-process deaths.
 *
 * Why durable: `GpuCrashFallbackTracker` counts crashes in memory, so its count
 * resets to zero on every launch. The 39 Windows bundles hold 111 distinct GPU child
 * deaths over 73 launches that retained an `app_started` breadcrumb; 66 of those
 * launches recorded one or two deaths, and 7 recorded four inside 90ms.
 *
 * So the 3-in-30s threshold is reachable, not unreachable — it is met on those 7, and
 * 36 launches started with safe graphics already applied. What it misses is the common
 * shape. Measured per machine (one bundle is one ring buffer), of the 21 bundles holding
 * a fallback-eligible death, 2 reach three inside 30s within a single launch and 6 reach
 * three inside 5 minutes when counted across launches. Tripling the reach is the claim
 * this file supports; making an unreachable threshold reachable is not.
 *
 * Per-launch counts are a floor rather than a measurement either way, since
 * `process_gone_suppressed` coalesces identical repeats on a 30s key.
 *
 * Not established by that data: that engaging helps. 57 of the 111 deaths landed on a
 * launch that had already applied safe graphics, all STATUS_BREAKPOINT — but every one
 * predates `--in-process-gpu` (#11295, v1.4.163, tagged 5h after the last of them),
 * which is what finally removed the GPU child the old fallback left running. Efficacy
 * of the current fallback is unmeasured in both directions.
 *
 * Why a standalone file (not the Store): same reason as gpu-fallback-marker.ts —
 * this is read and written before app.whenReady(), where the Store does not exist.
 */

export const GPU_CRASH_HISTORY_FILE = 'gpu-crash-history.json'
export const GPU_CRASH_HISTORY_SCHEME_VERSION = 1

/**
 * Why 5 minutes, derived from the measured distribution rather than rounded up:
 * the gap between consecutive crashing launches was 18-24s (median), and the
 * first 8 crashes on F0BN5HZL8FJ span 96s (12s/crash). Three crashes therefore
 * need ~40-50s. Five minutes tolerates ~2.5 min on each of the two inter-crash
 * gaps — 6-8x the observed median, enough for a user who reads the Windows crash
 * dialog or tries a driver update before relaunching — and still covers ~12
 * consecutive launches at the observed rate.
 *
 * What the code actually reaches back is 360s, not 300s: GPU_CRASH_HISTORY_FUTURE_SKEW_MS
 * lets an entry sit up to 60s ahead of now, so one written by a clock running 60s fast
 * survives 360s of real elapsed time. That 360s is the number to argue against.
 *
 * Why not 10 minutes: false-positive surface scales linearly with the window, and the
 * marker is written before the user consents — 360s of worst-case reach is already the
 * ceiling this trade accepts. Too short only delays the remedy to the next tight burst;
 * too long latches safe graphics on a machine that was never in the loop. The asymmetry
 * says pick the shorter number.
 */
export const DEFAULT_GPU_CRASH_DURABLE_WINDOW_MS = 300_000

/**
 * Why 32: an order of magnitude above the threshold of 3, so the cap can never
 * suppress a crossing (that would need >32 crashes inside the window, which is
 * 10x over threshold and already firing). Eviction is oldest-first — entries
 * nearest to ageing out anyway. Future-dated entries are dropped before the cap
 * applies, so a bad clock cannot fill it and crowd out real crashes.
 */
export const MAX_GPU_CRASH_HISTORY_ENTRIES = 32

// Why tolerated at all: NTP corrections move the wall clock by seconds. Anything
// further ahead is a bad clock, and trusting it would pin a stale crash in the
// window until the clock caught up.
const GPU_CRASH_HISTORY_FUTURE_SKEW_MS = 60_000

export type GpuCrashHistoryDecision = {
  /** Times to persist, oldest first. */
  crashTimes: number[]
  crashesInWindow: number
  /** True once the durable count reaches the fallback threshold. */
  crossesThreshold: boolean
}

/** Epoch-ms crash times still inside the window, dropping anything a clock jump made nonsense. */
export function pruneGpuCrashTimes(
  times: readonly unknown[],
  now: number,
  windowMs: number
): number[] {
  if (!Number.isFinite(now)) {
    return []
  }
  const oldest = now - windowMs
  const newest = now + GPU_CRASH_HISTORY_FUTURE_SKEW_MS
  return times
    .filter(
      (time): time is number =>
        typeof time === 'number' &&
        Number.isFinite(time) &&
        time >= 0 &&
        time >= oldest &&
        time <= newest
    )
    .sort((a, b) => a - b)
}

/** Adds `now` to `times` and reports whether the durable threshold is now met. */
export function appendGpuCrashTime(
  times: readonly unknown[],
  now: number,
  options: { windowMs: number; threshold: number; maxEntries?: number }
): GpuCrashHistoryDecision {
  const pruned = pruneGpuCrashTimes([...times, now], now, options.windowMs)
  // Keep the newest: the entries dropped here are the ones about to age out anyway.
  const crashTimes = pruned.slice(-(options.maxEntries ?? MAX_GPU_CRASH_HISTORY_ENTRIES))
  return {
    crashTimes,
    crashesInWindow: crashTimes.length,
    crossesThreshold: crashTimes.length >= options.threshold
  }
}

/** Why a factory: a shared instance would hand every caller the same mutable array. */
export function inertGpuCrashHistoryDecision(): GpuCrashHistoryDecision {
  return { crashTimes: [], crashesInWindow: 0, crossesThreshold: false }
}

function historyPath(userDataPath: string): string {
  return join(userDataPath, GPU_CRASH_HISTORY_FILE)
}

/** Why exported: the startup temp sweep is gated on a fallback file having existed. */
export function gpuCrashHistoryFileExists(userDataPath: string): boolean {
  return existsSync(historyPath(userDataPath))
}

/** Why no retry: a stale history costs at most one extra loop iteration. */
function clearHistoryBestEffort(userDataPath: string): void {
  try {
    rmSync(historyPath(userDataPath), { force: true })
  } catch {
    // The next launch revalidates it anyway.
  }
}

export function clearGpuCrashHistory(userDataPath: string): void {
  clearHistoryBestEffort(userDataPath)
}

/** Times this build may count, or null when the file is corrupt or another build's. */
function parseGpuCrashHistory(raw: string, environment: GpuFallbackEnvironment): number[] | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (
    parsed.schemeVersion !== GPU_CRASH_HISTORY_SCHEME_VERSION ||
    parsed.platform !== 'win32' ||
    parsed.appVersion !== environment.appVersion ||
    parsed.electronVersion !== environment.electronVersion
  ) {
    return null
  }
  const stored: unknown[] = Array.isArray(parsed.crashTimes) ? parsed.crashTimes : []
  // Range checks belong to pruneGpuCrashTimes, which needs `now`; this is only the
  // shape boundary, so a hand-edited file cannot put a string into the array.
  return stored.filter(
    (time): time is number => typeof time === 'number' && Number.isFinite(time) && time >= 0
  )
}

/**
 * Stored crash times for this exact build. A mismatched build or platform discards
 * them, the same policy the marker uses: a new build gets one clean slate.
 */
export function readGpuCrashHistory(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): number[] {
  if (environment.platform !== 'win32') {
    clearHistoryBestEffort(userDataPath)
    return []
  }
  let raw: string
  try {
    raw = readFileSync(historyPath(userDataPath), 'utf-8')
  } catch {
    // Missing or unreadable means no history.
    return []
  }
  const times = parseGpuCrashHistory(raw, environment)
  if (times === null) {
    // Why removed rather than left for the next write to overwrite: an unusable file
    // still arms the startup temp sweep for every launch it survives.
    clearHistoryBestEffort(userDataPath)
    return []
  }
  return times
}

/**
 * Deletes a history whose entries have all aged out, so it stops arming the startup
 * temp sweep for the life of the install. Why not inside persistGpuCrashTimes: its
 * caller always appends `now`, so the crash path never sees an empty result — only a
 * later launch does.
 *
 * Why async: the launch that pays for this file already runs the sweep off the critical
 * path, and startup must not take on a synchronous read to earn back an async readdir.
 * The one race is a GPU death landing between the read and the unlink — its listener is
 * registered inside app.whenReady(), so it needs a read slow enough to still be pending
 * then. It costs that launch's first entry and nothing else, degrading toward not
 * firing, which is the same direction every other edge in this feature takes.
 */
export async function discardExpiredGpuCrashHistory(
  userDataPath: string,
  environment: GpuFallbackEnvironment,
  options: { now: number; windowMs: number }
): Promise<void> {
  const target = historyPath(userDataPath)
  let raw: string
  try {
    raw = await readFile(target, 'utf-8')
  } catch {
    // Missing is the outcome this aims for; unreadable is retried next launch.
    return
  }
  // Off Windows the file only followed a profile here, so nothing in it is countable.
  const times = environment.platform === 'win32' ? parseGpuCrashHistory(raw, environment) : null
  // A live entry is the cross-launch evidence this file exists to accumulate.
  if (times !== null && pruneGpuCrashTimes(times, options.now, options.windowMs).length > 0) {
    return
  }
  try {
    await rm(target, { force: true })
  } catch {
    // An AV/indexer hold on Windows costs one more armed sweep, nothing else.
  }
}

/**
 * Persists `crashTimes`. Never throws: this runs on the crash path racing
 * Chromium's kill, and a lost entry only costs one more iteration of the loop.
 *
 * Why separate from the evaluation: the caller skips this entirely on the crash
 * that fires the fallback, so its fsync never lands in front of the marker write.
 */
export function persistGpuCrashTimes(
  userDataPath: string,
  environment: GpuFallbackEnvironment,
  crashTimes: readonly number[]
): void {
  if (environment.platform !== 'win32') {
    return
  }
  const target = historyPath(userDataPath)
  const payload = JSON.stringify({
    schemeVersion: GPU_CRASH_HISTORY_SCHEME_VERSION,
    crashTimes,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: 'win32'
  })
  const tmp = durableWriteTempPath(target)
  try {
    writeFileDurableSync(tmp, target, payload)
    return
  } catch {
    // Windows AV/indexer holds make renameSync EPERM where a direct write still lands.
  }
  try {
    writeFileSync(target, payload)
  } catch {
    // Nothing left to try; the in-process tracker is still armed for this session.
  }
  try {
    rmSync(tmp, { force: true })
  } catch {
    // Swept next launch alongside the marker's orphans.
  }
}

/**
 * Reads the stored history, adds a GPU child death at `options.now` (epoch ms),
 * and reports whether the durable count has reached the threshold. Writes nothing
 * — the caller decides, so a fallback that fires can go straight to the marker.
 * Inert off Windows.
 */
export function evaluateGpuCrashHistory(
  userDataPath: string,
  environment: GpuFallbackEnvironment,
  options: { now: number; windowMs: number; threshold: number }
): GpuCrashHistoryDecision {
  if (environment.platform !== 'win32') {
    return inertGpuCrashHistoryDecision()
  }
  return appendGpuCrashTime(readGpuCrashHistory(userDataPath, environment), options.now, {
    windowMs: options.windowMs,
    threshold: options.threshold
  })
}

/** Why: the kill this history exists to survive can land between write and rename. */
export async function sweepStaleGpuCrashHistoryTempFiles(userDataPath: string): Promise<void> {
  await removeStaleDurableWriteTempFiles(historyPath(userDataPath))
}
