// Starts Electron's Crashpad handler and pairs a written minidump with the
// `render-process-gone` / `child-process-gone` event that reported the death.
//
// Upload stays off: dumps contain process memory, and the only transport we
// have (observability/diagnostic-bundle-upload) is a user-initiated 4 MiB text
// bundle. We keep dumps on disk and lift the *text* signature out of them, so
// a CHECK failure becomes nameable without shipping raw memory anywhere.

import type { Dirent } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, crashReporter } from 'electron'
import {
  parseMinidumpCrashSignature,
  type MinidumpCrashSignature
} from './minidump-crash-signature'

// Why: Crashpad writes the dump from the handler process while Electron
// delivers process-gone on the main thread; the two race. Poll a short window
// rather than sampling once and losing the dump most of the time.
const DUMP_WAIT_TIMEOUT_MS = 8_000
const DUMP_POLL_INTERVAL_MS = 250
// A dump older than this belongs to an earlier crash, not the one we're pairing.
const DUMP_RECENCY_WINDOW_MS = 30_000
// Renderer dumps run ~1-15 MiB; well past that means we mis-picked a file.
const MAX_DUMP_BYTES = 64 * 1024 * 1024
// Match Crashpad's default budget, but enforce it after crashes instead of
// waiting for its first 10-minute and later daily pruning passes.
const MAX_STORED_DUMP_BYTES = 128 * 1024 * 1024
// A burst of small dumps stays under the byte budget while still growing the
// directory walk, so cap the file count too.
const MAX_STORED_DUMPS = 64
const DUMP_PRUNE_DELAY_MS = 2_000

type DumpCandidate = {
  readonly filePath: string
  readonly mtimeMs: number
  readonly size: number
}

// Why: `app.getPath('crashDumps')` is derived from userData, which shifts when app.setName runs
// (at whenReady for packaged builds; before startCrashpadCapture in dev). Snapshot where Crashpad
// was actually pointed.
let crashpadDumpDirectory: string | null = null
let captureStarted = false
let captureStartedAtMs: number | null = null
const claimedDumpPaths = new Map<string, number>()
const reservedDumpPaths = new Set<string>()
let dumpPruneTimer: NodeJS.Timeout | null = null

export type CrashpadCaptureOptions = {
  /** Overrides Electron's default so tests need no real Crashpad handler. */
  readonly dumpDirectory?: string
}

/**
 * Must run before `app.whenReady()`. Safe to call twice; the second call is a
 * no-op so a re-entrant startup path cannot restart the handler.
 */
export function startCrashpadCapture(options: CrashpadCaptureOptions = {}): boolean {
  if (captureStarted) {
    return true
  }
  try {
    crashReporter.start({
      // Why: no submitURL is configured anywhere, and uploadToServer:true with
      // an unset URL makes Crashpad retry against a bogus endpoint forever.
      uploadToServer: false,
      // Keep the OS handler (WER / Apple crash reporter) in the loop; it costs
      // nothing and is the only signal left if Crashpad itself fails to init.
      ignoreSystemCrashHandler: false,
      compress: false
    })
    captureStarted = true
    captureStartedAtMs = Date.now()
  } catch (error) {
    console.error('[crash-reporting] Crashpad start failed:', error)
    return false
  }
  crashpadDumpDirectory = options.dumpDirectory ?? resolveDumpDirectory()
  // Why: a dying main process never delivers process-gone, so a crash loop
  // never reaches the post-crash prune, and Crashpad's own pass runs in the
  // handler child after a delayed first sweep. Pruning here is the only thing
  // that bounds disk across repeatedly crashed launches, so it must not be
  // deferred behind the coalescing timer a crash loop outruns.
  void pruneCrashpadDumps().catch((error) => {
    console.error('[crash-reporting] Crashpad startup dump pruning failed:', error)
  })
  return true
}

function resolveDumpDirectory(): string | null {
  try {
    return app.getPath('crashDumps')
  } catch {
    return null
  }
}

export function getCrashpadDumpDirectory(): string | null {
  return crashpadDumpDirectory
}

/** Test seam; production callers go through startCrashpadCapture. */
export function _setCrashpadCaptureStateForTest(
  state: { dumpDirectory: string | null; started: boolean; startedAtMs?: number } | null
): void {
  crashpadDumpDirectory = state?.dumpDirectory ?? null
  captureStarted = state?.started ?? false
  captureStartedAtMs = state?.started ? (state.startedAtMs ?? Number.NEGATIVE_INFINITY) : null
  claimedDumpPaths.clear()
  reservedDumpPaths.clear()
  if (dumpPruneTimer) {
    clearTimeout(dumpPruneTimer)
    dumpPruneTimer = null
  }
}

async function collectDumpCandidates(directory: string): Promise<DumpCandidate[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, {
      withFileTypes: true,
      recursive: true
    })
  } catch {
    return []
  }
  const candidates: DumpCandidate[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.dmp')) {
      continue
    }
    // `recursive` yields nested names relative to parentPath, not directory.
    const filePath = path.join(entry.parentPath ?? directory, entry.name)
    try {
      const stats = await stat(filePath)
      candidates.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size })
    } catch {
      // Crashpad renames dumps as it promotes them; a vanished file is normal.
    }
  }
  return candidates
}

async function pruneCrashpadDumps(
  maxBytes = MAX_STORED_DUMP_BYTES,
  maxDumps = MAX_STORED_DUMPS
): Promise<void> {
  const directory = crashpadDumpDirectory
  if (!directory) {
    return
  }
  const candidates = (await collectDumpCandidates(directory)).sort(
    (left, right) => right.mtimeMs - left.mtimeMs
  )
  let retainedBytes = 0
  let retainedCount = 0
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    // claimed dumps are referenced by a persisted report; pruning one leaves a
    // dangling minidumpPath behind.
    const mustKeep =
      index === 0 ||
      reservedDumpPaths.has(candidate.filePath) ||
      claimedDumpPaths.has(candidate.filePath)
    if (mustKeep || (retainedBytes + candidate.size <= maxBytes && retainedCount < maxDumps)) {
      retainedBytes += candidate.size
      retainedCount += 1
      continue
    }
    try {
      await rm(candidate.filePath, { force: true })
    } catch {
      // Crashpad can still be promoting a dump; its own later pass will retry.
    }
  }
}

/** Coalesces crash-burst pruning; there is no timer or directory scan while idle. */
export function scheduleCrashpadDumpPrune(): void {
  if (!crashpadDumpDirectory || dumpPruneTimer) {
    return
  }
  dumpPruneTimer = setTimeout(() => {
    void pruneCrashpadDumps()
      .catch((error) => {
        console.error('[crash-reporting] Crashpad dump pruning failed:', error)
      })
      .finally(() => {
        dumpPruneTimer = null
      })
  }, DUMP_PRUNE_DELAY_MS)
  dumpPruneTimer.unref()
}

/** Test seam for byte/count-budget behavior without a real Crashpad database. */
export async function _pruneCrashpadDumpsForTest(
  maxBytes: number,
  maxDumps = MAX_STORED_DUMPS
): Promise<void> {
  await pruneCrashpadDumps(maxBytes, maxDumps)
}

type DumpPollingOptions = {
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export type CrashMinidumpCaptureOptions = DumpPollingOptions & {
  readonly expectedProcessType?: string
}

function freshDumpCandidates(candidates: DumpCandidate[], crashedAtMs: number): DumpCandidate[] {
  const floorMs = Math.max(
    crashedAtMs - DUMP_RECENCY_WINDOW_MS,
    captureStartedAtMs ?? Number.NEGATIVE_INFINITY
  )
  for (const [filePath, mtimeMs] of claimedDumpPaths) {
    if (mtimeMs < floorMs) {
      claimedDumpPaths.delete(filePath)
    }
  }
  return candidates
    .filter((candidate) => candidate.mtimeMs >= floorMs && candidate.size <= MAX_DUMP_BYTES)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function pollDumpCandidates<T>(
  crashedAtMs: number,
  options: DumpPollingOptions,
  select: (candidate: DumpCandidate) => Promise<T | null>
): Promise<T | null> {
  const directory = crashpadDumpDirectory
  if (!directory) {
    return null
  }
  const timeoutMs = options.timeoutMs ?? DUMP_WAIT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs

  for (;;) {
    const fresh = freshDumpCandidates(await collectDumpCandidates(directory), crashedAtMs)
    for (const candidate of fresh) {
      const selected = await select(candidate)
      if (selected !== null) {
        return selected
      }
    }
    if (now() >= deadline) {
      return null
    }
    await sleep(DUMP_POLL_INTERVAL_MS)
  }
}

/**
 * Waits for the dump Crashpad writes for a crash observed at `crashedAtMs`.
 * Resolves null when capture is off, the handler wrote nothing, or the only
 * dumps on disk predate this crash.
 */
export async function waitForCrashMinidump(
  crashedAtMs: number,
  options: DumpPollingOptions = {}
): Promise<DumpCandidate | null> {
  return pollDumpCandidates(crashedAtMs, options, async (candidate) => candidate)
}

export type CapturedMinidump = {
  readonly filePath: string
  readonly sizeBytes: number
  readonly signature: MinidumpCrashSignature
}

/** Finds the dump for a crash and parses its signature. Never throws. */
export async function captureMinidumpSignature(
  crashedAtMs: number,
  options: CrashMinidumpCaptureOptions = {}
): Promise<CapturedMinidump | null> {
  const rejectedDumpPaths = new Set<string>()
  try {
    return await pollDumpCandidates(crashedAtMs, options, async (dump) => {
      if (
        rejectedDumpPaths.has(dump.filePath) ||
        claimedDumpPaths.has(dump.filePath) ||
        reservedDumpPaths.has(dump.filePath)
      ) {
        return null
      }
      reservedDumpPaths.add(dump.filePath)
      try {
        const signature = parseMinidumpCrashSignature(await readFile(dump.filePath), {
          expectedProcessType: options.expectedProcessType
        })
        if (
          !signature ||
          (options.expectedProcessType !== undefined &&
            signature.processType !== options.expectedProcessType)
        ) {
          rejectedDumpPaths.add(dump.filePath)
          return null
        }
        claimedDumpPaths.set(dump.filePath, dump.mtimeMs)
        return { filePath: dump.filePath, sizeBytes: dump.size, signature }
      } finally {
        reservedDumpPaths.delete(dump.filePath)
      }
    })
  } catch (error) {
    console.error('[crash-reporting] minidump signature capture failed:', error)
    return null
  }
}
