// Temporary: imports the single JSON file that builds before the per-row
// database wrote, so the first launch after updating re-reads nothing. Remove
// once no supported upgrade path starts from a build that wrote that file.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  parsePersistedSessionParseCacheRow,
  SESSION_PARSE_CACHE_SCHEMA_VERSION,
  type SessionParseCacheDatabase
} from './session-parse-cache-database'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'

// The limit the old writer kept the file within.
const LEGACY_MAX_BYTES = 64 * 1024 * 1024

/**
 * Runs when the database opens, before any lookup or write can reach it, so a
 * delete can't be undone and an early title lookup can't make the import look
 * done. Synchronous: it happens once per profile, in the scanner child. Rows
 * already in the database win; the file (and any temp file a crashed save
 * left) is deleted whether or not it parsed.
 */
export function importLegacySessionParseCacheJson(
  filePath: string,
  database: SessionParseCacheDatabase,
  seenAt: number
): void {
  try {
    if (statSync(filePath).size <= LEGACY_MAX_BYTES) {
      database.write(readLegacyEntries(readFileSync(filePath, 'utf8')), seenAt, true)
    }
  } catch {
    // Missing, corrupt or foreign: the worst case is a cold scan.
  }
  removeLegacyFiles(filePath)
}

function readLegacyEntries(text: string): [string, PersistedSessionParseCacheEntry][] {
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('schemaVersion' in parsed) ||
    parsed.schemaVersion !== SESSION_PARSE_CACHE_SCHEMA_VERSION ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    return []
  }
  return parsed.entries.flatMap((item: unknown) => {
    const entry = parsePersistedSessionParseCacheRow(item)
    return entry === null ? [] : [entry]
  })
}

function removeLegacyFiles(filePath: string): void {
  const directory = dirname(filePath)
  let names: string[] = []
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (
      name === basename(filePath) ||
      (name.startsWith('session-parse-cache-') && name.endsWith('.tmp'))
    ) {
      try {
        rmSync(join(directory, name), { force: true })
      } catch {
        // Retried on the next open.
      }
    }
  }
}
