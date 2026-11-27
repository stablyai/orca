import { readFile } from 'node:fs/promises'
import { removeStaleDurableWriteTempFiles } from '../../../../filesystem/durable-file-write'
import { writeQuietly } from './orchestration-db-compaction-files'

const MIB = 1024 * 1024
// Each copy rewrites the live data, so a file whose copies keep going stale waits longer each time: an
// hour after the first, doubling up to a day. After this many it gives up, and the file keeps its size.
export const MAX_COPIES = 3
export const ATTEMPT_SPACING_MS = 60 * 60_000
export const MAX_ATTEMPT_SPACING_MS = 24 * ATTEMPT_SPACING_MS
// The copy blocks no one; this only bounds the disk and CPU it uses, at a slow disk's pace.
export const MIN_COPY_BUDGET_MS = 120_000
const SLOW_COPY_BYTES_PER_MS = (4 * MIB) / 1000
const MAX_BUDGET_DOUBLINGS = 6
// Node fires a longer timer after 1 ms.
const MAX_TIMER_MS = 2_147_483_647

/** Since the last copy started; an hour even when none went unused yet (a quit or crash cut it short). */
export function attemptSpacingMs(attempts: number): number {
  return Math.min(ATTEMPT_SPACING_MS * 2 ** Math.max(attempts - 1, 0), MAX_ATTEMPT_SPACING_MS)
}

/** Doubled with each attempt, so a disk slower than assumed still finishes one in the end. */
export function copyBudgetMs(liveBytes: number, attempts: number): number {
  return Math.min(
    Math.max(MIN_COPY_BUDGET_MS, Math.round(liveBytes / SLOW_COPY_BYTES_PER_MS)) *
      2 ** Math.min(attempts - 1, MAX_BUDGET_DOUBLINGS),
    MAX_TIMER_MS
  )
}

/** `<unused copies> <start of the last, ms> [<count if the last copy is still in flight>]`, across sessions. */
export async function readAttempts(
  path: string
): Promise<{ attempts: number; lastAttemptAt: number }> {
  // A write a quit or crash cut short leaves its temp file; the profile lock keeps that process gone.
  await removeStaleDurableWriteTempFiles(path)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // Only a missing record means no copies yet; one that can't be read holds copies off this session.
    return {
      attempts: isMissingFile(error) ? 0 : Number.POSITIVE_INFINITY,
      lastAttemptAt: Number.NEGATIVE_INFINITY
    }
  }
  const [count, at, inFlight] = text.split(' ').map(Number)
  // A copy still marked in flight never got swapped in: it counts.
  return {
    attempts: Math.max(count || 0, inFlight || 0),
    lastAttemptAt: at || Number.NEGATIVE_INFINITY
  }
}

/** In flight: the copy about to start counts as used unless a later write records otherwise. */
export function writeAttempts(
  path: string,
  attempts: number,
  at: number,
  inFlight = false
): Promise<boolean> {
  return writeQuietly(path, inFlight ? `${attempts} ${at} ${attempts + 1}` : `${attempts} ${at}`)
}

// The error's code only: a message can quote a path that happens to read like one.
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
