import { terminalWaitBlockedSentinelRe } from './agent-state-rules/blocked-text-layer'

/** Cache sentinel positions by immutable tail-array identity to avoid scanning 2,000 retained lines per tick.
 * Weak keys release replaced tails; record the regex too so hot-reloaded rules cannot hide new blockers. */
const sentinelMatchesByTailLines = new WeakMap<
  readonly string[],
  { sentinel: RegExp; matches: number[] }
>()

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

/** Count full scans of unseen arrays; constructor-produced tails must already be indexed so tests can detect bypassed carry paths. */
let sentinelFullScanCount = 0

export function getTerminalTailSentinelFullScanCount(): number {
  return sentinelFullScanCount
}

/** Ascending indices of sentinel-matching lines; full-scans an unseen array. */
export function getTerminalTailSentinelMatches(lines: readonly string[]): readonly number[] {
  const sentinel = terminalWaitBlockedSentinelRe()
  const cached = sentinelMatchesByTailLines.get(lines)
  if (cached?.sentinel === sentinel) {
    return cached.matches
  }
  sentinelFullScanCount += 1
  const matches: number[] = []
  collectSentinelMatches(sentinel, lines, 0, matches)
  sentinelMatchesByTailLines.set(lines, { sentinel, matches })
  return matches
}

export function tailMayContainBlockedSignal(lines: readonly string[]): boolean {
  return getTerminalTailSentinelMatches(lines).length > 0
}

/** Derive new matches from the exact unchanged carry window; scan only produced rows and drop evicted/rewritten matches.
 * buildCarriedTailLines derives this window and the next array from the same capped bounds. */
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
  const sentinel = terminalWaitBlockedSentinelRe()
  collectSentinelMatches(sentinel, nextLines, carriedCount, matches)
  sentinelMatchesByTailLines.set(nextLines, { sentinel, matches })
}
