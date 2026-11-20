import { randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { track } from '../../../telemetry/client'
import type { CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES } from '../../../../shared/telemetry/schemas/telemetry-codex-legacy-history-event-schemas'

export type LegacyHistoryImportOutcome = (typeof CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES)[number]

/** Launches that try the import before it gives up; the kept copies stay either way. */
export const MAX_HISTORY_IMPORT_ATTEMPTS = 3

export type LegacyMigrationMarker = {
  completedAt?: number
  migratedHomeCount?: number
  /** Kept legacy histories still wait to seed a shared history that doesn't exist yet. */
  historyImportPending?: true
  historyImportAttempts?: number
}

export function parseLegacyMigrationMarker(text: string): LegacyMigrationMarker {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') {
    return {}
  }
  const marker: LegacyMigrationMarker = {}
  if ('completedAt' in parsed && typeof parsed.completedAt === 'number') {
    marker.completedAt = parsed.completedAt
  }
  if ('migratedHomeCount' in parsed && typeof parsed.migratedHomeCount === 'number') {
    marker.migratedHomeCount = parsed.migratedHomeCount
  }
  if ('historyImportPending' in parsed && parsed.historyImportPending === true) {
    marker.historyImportPending = true
  }
  if ('historyImportAttempts' in parsed && typeof parsed.historyImportAttempts === 'number') {
    marker.historyImportAttempts = parsed.historyImportAttempts
  }
  return marker
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

// Every kept copy, accounts and their preserved versions in a stable order.
async function listKeptLegacyHistories(keptRoot: string): Promise<string[]> {
  const paths: string[] = []
  const accounts = await readdir(keptRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return []
    }
    throw error
  })
  for (const account of accounts.filter((entry) => entry.isDirectory()).sort(byName)) {
    const files = await readdir(join(keptRoot, account.name), { withFileTypes: true })
    for (const file of files.filter((entry) => entry.isFile()).sort(byName)) {
      if (file.name.endsWith('.jsonl')) {
        paths.push(join(keptRoot, account.name, file.name))
      }
    }
  }
  return paths
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * Codex may be appending to or trimming a shared history.jsonl that exists, so only a missing one is
 * created from Orca's kept copies, and never over one Codex creates meanwhile.
 */
export async function publishKeptLegacyHistoriesIfAbsent(
  keptRoot: string,
  runtimeHistoryPath: string
): Promise<LegacyHistoryImportOutcome> {
  try {
    if (await pathExists(runtimeHistoryPath)) {
      return 'skipped_existing'
    }
    const seenLines = new Set<string>()
    for (const keptPath of await listKeptLegacyHistories(keptRoot)) {
      for (const line of (await readFile(keptPath, 'utf-8')).split('\n')) {
        if (line) {
          seenLines.add(line)
        }
      }
    }
    if (seenLines.size === 0) {
      return 'nothing_to_import'
    }
    return (await publishWithoutOverwrite(`${[...seenLines].join('\n')}\n`, runtimeHistoryPath))
      ? 'imported'
      : 'skipped_existing'
  } catch (error) {
    console.warn('[codex-runtime-home] Failed to import legacy Codex prompt history:', error)
    return 'failed'
  }
}

async function publishWithoutOverwrite(contents: string, targetPath: string): Promise<boolean> {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // A hard link publishes only into a free name: one Codex created meanwhile stays as it is.
    await link(tmpPath, targetPath)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'EEXIST') {
      return false
    }
    throw error
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
