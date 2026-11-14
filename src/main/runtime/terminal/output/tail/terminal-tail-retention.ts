import { trimTerminalLineRight } from './terminal-tail-line-controls'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES } from './terminal-tail-limits'
import { carryTerminalTailSentinelMatches } from './terminal-tail-sentinel-index'
import {
  getTerminalLineOrigins,
  setTerminalLineOrigins
} from '../../../../../shared/terminal/output/terminal-content-origin'

type RetainedTailLineStats = {
  totalChars: number
  /** Whether every line is already right-trimmed, so the redraw prefix trim is a no-op. */
  rightTrimmed: boolean
}

// Append replaces arrays; weak array keys let stats die with each tail while avoiding a full character re-sum per chunk.
const tailLineStatsByLines = new WeakMap<readonly string[], RetainedTailLineStats>()

export function getRetainedTailLineStats(lines: readonly string[]): RetainedTailLineStats {
  const cached = tailLineStatsByLines.get(lines)
  if (cached) {
    return cached
  }
  let totalChars = 0
  let rightTrimmed = true
  for (const line of lines) {
    totalChars += line.length
    if (rightTrimmed && trimTerminalLineRight(line) !== line) {
      rightTrimmed = false
    }
  }
  const stats = { totalChars, rightTrimmed }
  tailLineStatsByLines.set(lines, stats)
  return stats
}

type CarriedTailBuild = {
  lines: string[]
  /** Whether a retention cap dropped a row. */
  truncated: boolean
}

/** Derive array, character total and sentinel carry window from the same capped keep bounds; callers must right-trim appended rows. */
export function buildCarriedTailLines(
  previousLines: string[],
  keepStart: number,
  keepEnd: number,
  appended: readonly string[],
  charCapPartialChars: number | null
): CarriedTailBuild {
  const keptCount = keepEnd > keepStart ? keepEnd - keepStart : 0
  let totalChars = 0
  let carriedRightTrimmed = true
  if (keptCount > 0) {
    const previousStats = getRetainedTailLineStats(previousLines)
    totalChars = previousStats.totalChars
    carriedRightTrimmed = previousStats.rightTrimmed
    for (let index = 0; index < keepStart; index += 1) {
      totalChars -= previousLines[index]!.length
    }
    for (let index = keepEnd; index < previousLines.length; index += 1) {
      totalChars -= previousLines[index]!.length
    }
  }
  for (const line of appended) {
    totalChars += line.length
  }

  // Both caps only ever drop from the front, so resolve them against the virtual concatenation
  // before the array exists; the surviving keep bounds then define the carried window exactly.
  const combinedLength = keptCount + appended.length
  let dropCount = combinedLength > MAX_TAIL_LINES ? combinedLength - MAX_TAIL_LINES : 0
  for (let index = 0; index < dropCount; index += 1) {
    totalChars -= (
      index < keptCount ? previousLines[keepStart + index]! : appended[index - keptCount]!
    ).length
  }
  if (charCapPartialChars !== null) {
    const charBudget = MAX_TAIL_CHARS - charCapPartialChars
    while (dropCount < combinedLength && totalChars > charBudget) {
      totalChars -= (
        dropCount < keptCount
          ? previousLines[keepStart + dropCount]!
          : appended[dropCount - keptCount]!
      ).length
      dropCount += 1
    }
  }

  if (
    dropCount === 0 &&
    appended.length === 0 &&
    keepStart === 0 &&
    keepEnd === previousLines.length
  ) {
    return { lines: previousLines, truncated: false }
  }

  const droppedFromCarried = dropCount < keptCount ? dropCount : keptCount
  const carriedSourceStart = keepStart + droppedFromCarried
  const carriedCount = keptCount - droppedFromCarried
  const lines = previousLines.slice(carriedSourceStart, keepEnd)
  const previousOrigins = getTerminalLineOrigins(previousLines)
  const appendedOrigins = getTerminalLineOrigins(appended)
  const origins =
    previousOrigins || appendedOrigins
      ? lines.map((_, index) => previousOrigins?.[carriedSourceStart + index] ?? [])
      : undefined
  for (let index = dropCount - droppedFromCarried; index < appended.length; index += 1) {
    lines.push(appended[index]!)
    origins?.push(appendedOrigins?.[index] ?? [])
  }
  if (origins) {
    setTerminalLineOrigins(lines, origins)
  }

  tailLineStatsByLines.set(lines, {
    totalChars,
    rightTrimmed: carriedCount === 0 || carriedRightTrimmed
  })
  carryTerminalTailSentinelMatches(previousLines, lines, carriedSourceStart, carriedCount)
  return { lines, truncated: dropCount > 0 }
}
