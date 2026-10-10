import { terminalWaitBlockedSentinelRe } from './agent-state-rules/blocked-text-layer'

/**
 * Which retained tail lines match the wait-blocked sentinel, memoized per
 * lines-array identity.
 *
 * Why: `computeTerminalTailWaitState` must prove the ABSENCE of a signal, so it
 * cannot early-exit and re-tested all 2000 retained lines on every scan (20/s
 * per streaming PTY) even though only ~20 lines were new. Keyed weakly by the
 * array so an entry dies with the tail it describes; the tail array is replaced
 * on every append and never mutated in place, so at most one entry per PTY
 * stays live. Each entry keeps the sentinel it was scanned with: a rules hot reload swaps it, and
 * matches found by the old one would hide a blocker only the new one knows.
 */
type SentinelIndexEntry = {
  sentinel: RegExp
  /** Ascending positions of matching rows among [0, scannedRows); later rows are untested. */
  matches: number[]
  scannedRows: number
}

const sentinelIndexByTailLines = new WeakMap<readonly string[], SentinelIndexEntry>()

function collectSentinelMatches(
  sentinel: RegExp,
  lines: readonly string[],
  startIndex: number,
  into: number[]
): void {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (sentinel.test(lines[index]!)) {
      into.push(index)
    }
  }
}

/**
 * How many arrays have been full-scanned because they arrived without an index entry.
 * Every array `appendNormalizedToTailBuffer` produces is registered by `buildCarriedTailLines`,
 * so this only advances for tails the index has genuinely never seen (a restore seed, a persisted
 * record, a hand-built array). Tests assert it stays flat across the real append paths, which is
 * what proves no producer path silently bypasses the constructor.
 */
let sentinelFullScanCount = 0

export function getTerminalTailSentinelFullScanCount(): number {
  return sentinelFullScanCount
}

/** Ascending indices of sentinel-matching lines; full-scans an unseen array. */
export function getTerminalTailSentinelMatches(lines: readonly string[]): readonly number[] {
  const sentinel = terminalWaitBlockedSentinelRe()
  const entry = sentinelIndexByTailLines.get(lines)
  if (entry?.sentinel === sentinel) {
    if (entry.scannedRows < lines.length) {
      collectSentinelMatches(sentinel, lines, entry.scannedRows, entry.matches)
      entry.scannedRows = lines.length
    }
    return entry.matches
  }
  sentinelFullScanCount += 1
  const matches: number[] = []
  collectSentinelMatches(sentinel, lines, 0, matches)
  sentinelIndexByTailLines.set(lines, { sentinel, matches, scannedRows: lines.length })
  return matches
}

export function tailMayContainBlockedSignal(lines: readonly string[]): boolean {
  return getTerminalTailSentinelMatches(lines).length > 0
}

/**
 * Register `nextLines` as derived from `previousLines`, deferring every sentinel test to the
 * first read.
 *
 * `nextLines[0 … carriedCount)` are the very same strings as
 * `previousLines[carriedSourceStart … carriedSourceStart + carriedCount)`, and
 * every later line is newly produced. That is not an assumption a caller has to
 * uphold by hand: `buildCarriedTailLines` in `terminal-tail-buffer.ts` is the
 * sole caller, and it derives this window from the same keep bounds it slices
 * `nextLines` out of, so the window and the array cannot disagree. Matches
 * outside the carried window are dropped because their lines were evicted or
 * rewritten, which is exactly what a full scan would conclude.
 *
 * Why deferred: the index is read by the throttled wait check, while a flood appends far more
 * rows than the tail keeps between two reads; rows evicted before a read are never tested.
 */
export function carryTerminalTailSentinelMatches(
  previousLines: readonly string[],
  nextLines: readonly string[],
  carriedSourceStart: number,
  carriedCount: number
): void {
  if (nextLines === previousLines) {
    return
  }
  const sentinel = terminalWaitBlockedSentinelRe()
  let previous = sentinelIndexByTailLines.get(previousLines)
  if (carriedCount > 0 && previous?.sentinel !== sentinel) {
    // Only a produced tail defers: an unseen or stale one is scanned now, as before.
    getTerminalTailSentinelMatches(previousLines)
    previous = sentinelIndexByTailLines.get(previousLines)
  }
  const matches: number[] = []
  let scannedRows = 0
  if (carriedCount > 0 && previous) {
    // Why positions, not the previous array: holding it would keep its evicted rows alive.
    scannedRows = Math.max(0, Math.min(carriedCount, previous.scannedRows - carriedSourceStart))
    const scannedEnd = carriedSourceStart + scannedRows
    for (const index of previous.matches) {
      if (index >= scannedEnd) {
        break
      }
      if (index >= carriedSourceStart) {
        matches.push(index - carriedSourceStart)
      }
    }
  }
  sentinelIndexByTailLines.set(nextLines, { sentinel, matches, scannedRows })
}
