import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  compareCodexSessionBackfillDates,
  isCodexSessionBackfillDate
} from './codex-session-backfill-scan-dates'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillOptions,
  CodexSessionBackfillScanProgress
} from './codex-session-backfill-types'

const MAX_SCAN_DIRECTORY_READS = 128
const MAX_SCAN_DAY_DIRECTORIES = 31

export function isCodexSessionRolloutPath(sessionsRoot: string, filePath: string): boolean {
  const pathParts = relative(sessionsRoot, filePath).split(sep)
  if (pathParts.length !== 4) {
    return false
  }
  const [year, month, day, fileName] = pathParts
  return isCodexSessionBackfillDate([year, month, day]) && /^rollout-.+\.jsonl$/.test(fileName)
}

export async function* listCodexSessionBackfillFilesForDates(
  sessionsRoot: string,
  options: CodexSessionBackfillOptions,
  progress: CodexSessionBackfillScanProgress,
  onDirectoryError: (directoryPath: string, error: unknown) => void | Promise<void>
): AsyncGenerator<string> {
  let freshReadsRemaining = Infinity
  let readsRemaining = options.boundedScan ? MAX_SCAN_DIRECTORY_READS : Infinity
  let daysRemaining = options.boundedScan ? MAX_SCAN_DAY_DIRECTORIES : Infinity
  let entriesSinceYield = 0
  const visitedDays = new Set<string>()
  const read = async (parts: readonly string[]) => {
    readsRemaining -= 1
    freshReadsRemaining -= 1
    const directoryPath = join(sessionsRoot, ...parts)
    try {
      return (await readdir(directoryPath, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? 1 : a.name > b.name ? -1 : 0
      )
    } catch (error) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readdir rejects with system errors; only the optional errno code is read.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        await onDirectoryError(directoryPath, error)
      }
      return []
    }
  }
  const pause = async () => {
    entriesSinceYield += 1
    if (entriesSinceYield >= Math.max(1, options.batchSize ?? 64)) {
      entriesSinceYield = 0
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, options.yieldMs ?? 10)))
    }
  }
  const walk = async function* (
    parts: readonly string[],
    cursor: readonly string[] | undefined,
    freshOnly: boolean
  ): AsyncGenerator<string> {
    if (options.shouldStop?.()) {
      return
    }
    if (
      cursor &&
      parts.slice(0, cursor.length).join('/') > cursor.slice(0, parts.length).join('/')
    ) {
      return
    }
    if (options.scanFrom && parts.join('/') < options.scanFrom.slice(0, parts.length).join('/')) {
      return
    }
    const dayKey = parts.join('/')
    if (parts.length === 3 && visitedDays.has(dayKey)) {
      return
    }
    if (
      readsRemaining <= 0 ||
      freshReadsRemaining <= 0 ||
      (parts.length === 3 && daysRemaining <= 0)
    ) {
      progress.truncated = true
      progress.cursor ??= parts
      return
    }
    if (parts.length === 3) {
      const date: CodexSessionBackfillDate = [parts[0], parts[1], parts[2]]
      visitedDays.add(dayKey)
      daysRemaining -= 1
      if (!cursor && progress.recentDates.length < 2) {
        progress.recentDates.push(date)
      }
      for (const entry of await read(parts)) {
        if (options.shouldStop?.()) {
          return
        }
        if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) {
          yield join(sessionsRoot, ...parts, entry.name)
        }
        await pause()
      }
      return
    }
    for (const entry of await read(parts)) {
      if (options.shouldStop?.() || progress.truncated) {
        return
      }
      if (freshOnly && visitedDays.size >= 2) {
        return
      }
      await pause()
      if (!entry.isDirectory() || !(parts.length === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        continue
      }
      const child = [...parts, entry.name]
      if (child.length === 3 && !isCodexSessionBackfillDate(child)) {
        continue
      }
      yield* walk(child, cursor, freshOnly)
    }
  }
  // A resumed tail shares one budget with fresh discovery, so new rollouts cannot starve it.
  if (options.scanCursor) {
    freshReadsRemaining = 32
    yield* walk([], undefined, true)
    freshReadsRemaining = Infinity
    progress.truncated = false
    progress.cursor = undefined
    yield* walk([], options.scanCursor, false)
  } else {
    yield* walk([], undefined, false)
  }
  progress.recentDates.sort((a, b) => compareCodexSessionBackfillDates(b, a))
}
