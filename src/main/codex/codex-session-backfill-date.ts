import { join, relative, sep } from 'node:path'
import { isCodexSessionBackfillDate } from './codex-session-backfill-scan-dates'
import { listCodexSessionJsonlFilesIncrementally } from './codex-session-file-listing'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillOptions
} from './codex-session-backfill-types'

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
    .filter(isCodexSessionBackfillDate)
    .map(([year, month, day]) => join(sessionsRoot, year, month, day))
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
