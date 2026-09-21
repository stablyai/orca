import { TERMINAL_WAIT_BLOCKED_SENTINEL_RE } from './terminal-wait-detection'

/**
 * Which retained tail lines match the wait-blocked sentinel, memoized per
 * lines-array identity.
 *
 * Why: `computeTerminalTailWaitState` must prove the ABSENCE of a signal, so it
 * cannot early-exit and re-tested all 2000 retained lines on every scan (20/s
 * per streaming PTY) even though only ~20 lines were new. Keyed weakly by the
 * array so an entry dies with the tail it describes; the tail array is replaced
 * on every append and never mutated in place, so at most one entry per PTY
 * stays live.
 */
const sentinelMatchesByTailLines = new WeakMap<readonly string[], number[]>()

function collectSentinelMatches(
  lines: readonly string[],
  startIndex: number,
  into: number[]
): void {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(lines[index]!)) {
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
  const cached = sentinelMatchesByTailLines.get(lines)
  if (cached) {
    return cached
  }
  sentinelFullScanCount += 1
  const matches: number[] = []
  collectSentinelMatches(lines, 0, matches)
  sentinelMatchesByTailLines.set(lines, matches)
  return matches
}

export function tailMayContainBlockedSignal(lines: readonly string[]): boolean {
  return getTerminalTailSentinelMatches(lines).length > 0
}

/**
 * Derive `nextLines`' match index from `previousLines`', testing only the lines
 * the append actually produced.
 *
 * `nextLines[0 … carriedCount)` are the very same strings as
 * `previousLines[carriedSourceStart … carriedSourceStart + carriedCount)`, and
 * every later line is newly produced. That is not an assumption a caller has to
 * uphold by hand: `buildCarriedTailLines` in `terminal-tail-buffer.ts` is the
 * sole caller, and it derives this window from the same keep bounds it slices
 * `nextLines` out of, so the window and the array cannot disagree. Matches
 * outside the carried window are dropped because their lines were evicted or
 * rewritten, which is exactly what a full scan would conclude.
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
  const matches: number[] = []
  if (carriedCount > 0) {
    const carriedEnd = carriedSourceStart + carriedCount
    for (const index of getTerminalTailSentinelMatches(previousLines)) {
      if (index >= carriedEnd) {
        break
      }
      if (index >= carriedSourceStart) {
        matches.push(index - carriedSourceStart)
      }
    }
  }
  collectSentinelMatches(nextLines, carriedCount, matches)
  sentinelMatchesByTailLines.set(nextLines, matches)
}
