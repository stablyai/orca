// Keep raw process-memory dumps local; extract text signatures to identify crashes.

import { constants as fsConstants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { open, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, crashReporter } from 'electron'
import { installAppImageCrashpadHandlerExit } from './appimage-crashpad-handler-exit'
import { createMinidumpFileSource, observeMinidumpExtent } from './minidump-file-source'
import {
  parseMinidumpCrashSignature,
  type MinidumpCrashSignature
} from './minidump-crash-signature'

// Crashpad writes asynchronously after process-gone; poll briefly to avoid missing its dump.
const DUMP_WAIT_TIMEOUT_MS = 8_000
const DUMP_POLL_INTERVAL_MS = 250
const DUMP_RECENCY_WINDOW_MS = 30_000
const MAX_DUMP_BYTES = 64 * 1024 * 1024
// Enforce Crashpad's storage budget without waiting for its delayed pruning passes.
const MAX_STORED_DUMP_BYTES = 128 * 1024 * 1024
// Small dumps can exhaust directory-walk time without hitting the byte budget.
const MAX_STORED_DUMPS = 64
const DUMP_PRUNE_DELAY_MS = 2_000

type DumpCandidate = {
  readonly filePath: string
  readonly mtimeMs: number
  readonly size: number
}

// Keep Crashpad's original directory: app.setName can later change userData and crashDumps.
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

/** Start before app.whenReady(); repeated calls must not restart the handler. */
export function startCrashpadCapture(options: CrashpadCaptureOptions = {}): boolean {
  if (captureStarted) {
    return true
  }
  try {
    crashReporter.start({
      // No submitURL is configured; avoid uploads and endless retries to an invalid endpoint.
      uploadToServer: false,
      // Preserve OS crash handling if Crashpad initialization fails.
      ignoreSystemCrashHandler: false,
      compress: false
    })
    captureStarted = true
    captureStartedAtMs = Date.now()
  } catch (error) {
    console.error('[crash-reporting] Crashpad start failed:', error)
    return false
  }
  installAppImageCrashpadHandlerExit()
  crashpadDumpDirectory = options.dumpDirectory ?? resolveDumpDirectory()
  // Prune immediately: repeated main-process crashes can outrun deferred cleanup.
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
    // Keep dumps referenced by persisted reports to avoid dangling minidump paths.
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
  select: (candidate: DumpCandidate, deadlineMs: number) => Promise<T | null>
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
      const selected = await select(candidate, deadline)
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

/** Wait briefly for a fresh dump; return null if capture is off or no matching dump arrives. */
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
    return await pollDumpCandidates(crashedAtMs, options, async (dump, deadlineMs) => {
      if (
        rejectedDumpPaths.has(dump.filePath) ||
        claimedDumpPaths.has(dump.filePath) ||
        reservedDumpPaths.has(dump.filePath)
      ) {
        return null
      }
      reservedDumpPaths.add(dump.filePath)
      try {
        // Reject symlink swaps where O_NOFOLLOW is available; also verify the opened file is regular.
        const noFollow = fsConstants.O_NOFOLLOW ?? 0
        const handle = await open(
          dump.filePath,
          noFollow === 0 ? 'r' : fsConstants.O_RDONLY | noFollow
        ).catch(() => {
          rejectedDumpPaths.add(dump.filePath)
          return null
        })
        if (handle === null) {
          return null
        }
        let signature: MinidumpCrashSignature | null
        let sizeBytes: number
        try {
          const stats = await handle.stat()
          if (!stats.isFile()) {
            rejectedDumpPaths.add(dump.filePath)
            return null
          }
          sizeBytes = await observeMinidumpExtent(handle, stats.size, {
            deadlineMs,
            now: options.now
          })
          const source = createMinidumpFileSource(handle, sizeBytes)
          signature = await parseMinidumpCrashSignature(source, {
            expectedProcessType: options.expectedProcessType
          })
          sizeBytes = source.byteLength
        } finally {
          await handle.close()
        }
        if (
          !signature ||
          (options.expectedProcessType !== undefined &&
            signature.processType !== options.expectedProcessType)
        ) {
          rejectedDumpPaths.add(dump.filePath)
          return null
        }
        claimedDumpPaths.set(dump.filePath, dump.mtimeMs)
        return { filePath: dump.filePath, sizeBytes, signature }
      } finally {
        reservedDumpPaths.delete(dump.filePath)
      }
    })
  } catch (error) {
    console.error('[crash-reporting] minidump signature capture failed:', error)
    return null
  }
}
