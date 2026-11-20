import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rm } from 'node:fs/promises'
import { publishFileWithoutOverwrite } from '../../../filesystem/atomic-file-publication'
import { track } from '../../../telemetry/client'
import type { CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES } from '../../../../shared/telemetry/schemas/telemetry-codex-legacy-history-event-schemas'

export type LegacyHistoryImportOutcome = (typeof CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES)[number]

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/** Creates the shared history from the legacy ones only while it doesn't exist; never writes one. */
export async function publishLegacyHistoryIfAbsent(
  legacyHistoryPaths: readonly string[],
  runtimeHistoryPath: string
): Promise<LegacyHistoryImportOutcome> {
  if (await pathExists(runtimeHistoryPath)) {
    return 'skipped_existing'
  }
  const seenLines = new Set<string>()
  for (const legacyHistoryPath of legacyHistoryPaths) {
    for (const line of (await readFile(legacyHistoryPath, 'utf-8')).split('\n')) {
      if (line) {
        seenLines.add(line)
      }
    }
  }
  if (seenLines.size === 0) {
    return 'skipped_existing'
  }
  const tmpPath = `${runtimeHistoryPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${[...seenLines].join('\n')}\n`, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // A hard link publishes only into a free name: one Codex created meanwhile stays as it is.
    return publishFileWithoutOverwrite(tmpPath, runtimeHistoryPath)
      ? 'imported'
      : 'skipped_existing'
  } finally {
    await rm(tmpPath, { force: true })
  }
}

export function trackLegacyHistoryImport(outcome: LegacyHistoryImportOutcome): void {
  try {
    track('codex_legacy_history_import', {
      outcome,
      platform:
        process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin'
    })
  } catch {
    // Telemetry never costs the migration.
  }
}
