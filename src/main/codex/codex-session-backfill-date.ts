import { join, relative, sep } from 'node:path'
import { listCodexSessionJsonlFilesIncrementally } from './codex-session-file-listing'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillOptions
} from './codex-session-backfill-types'

export function getCodexSessionBackfillDate(date = new Date()): CodexSessionBackfillDate {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ]
}

export function isCodexSessionRolloutPath(sessionsRoot: string, filePath: string): boolean {
  const pathParts = relative(sessionsRoot, filePath).split(sep)
  if (pathParts.length !== 4) {
    return false
  }
  const [year, month, day, fileName] = pathParts
  return (
    /^\d{4}$/.test(year) &&
    /^\d{2}$/.test(month) &&
    /^\d{2}$/.test(day) &&
    /^rollout-.+\.jsonl$/.test(fileName)
  )
}

export async function* listCodexSessionBackfillFilesForDates(
  sessionsRoot: string,
  options: CodexSessionBackfillOptions,
  onDirectoryError: (directoryPath: string, error: unknown) => void | Promise<void>
): AsyncGenerator<string> {
  const scanRoots = resolveCodexSessionBackfillDateRoots(sessionsRoot, options.scanDates)
  for (const scanRoot of scanRoots) {
    yield* listCodexSessionJsonlFilesIncrementally(
      scanRoot,
      options,
      async (directoryPath, error) => {
        if (directoryPath !== scanRoot || !isNotFoundError(error)) {
          await onDirectoryError(directoryPath, error)
        }
      }
    )
  }
}

function resolveCodexSessionBackfillDateRoots(
  sessionsRoot: string,
  scanDates: readonly CodexSessionBackfillDate[] | undefined
): string[] {
  if (!scanDates?.length) {
    return [sessionsRoot]
  }
  return scanDates
    .filter(
      ([year, month, day]) => /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day)
    )
    .map(([year, month, day]) => join(sessionsRoot, year, month, day))
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
