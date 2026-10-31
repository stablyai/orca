import { homedir } from 'node:os'
import { join } from 'node:path'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import type { ZcodeUsageProcessedDatabase } from './types'

function getDefaultZcodeDatabasePath(): string {
  return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
}

/** The CLI keeps every session and its usage in one SQLite database, so the scan
 *  has a single source and no sibling-ownership problem. */
export function resolveZcodeDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.ZCODE_DB?.trim()
  return override || getDefaultZcodeDatabasePath()
}

// Why gated: a ZCODE_DB override can point at a UNC path (a zcode CLI inside
// WSL), and a raw stat on a stalled distro would hang the whole scan (STA-4049).
export async function listZcodeDatabases(
  /** Lets a caller report the refusal; an empty list otherwise reads as
   *  "ZCode not used" rather than "we could not look". */
  onRefusal?: (path: string, error: WslTranscriptFsError) => void,
  /** Every other stat failure, including ENOENT; also read as an empty list. */
  onFsError?: (path: string, error: unknown) => void,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const databasePath = resolveZcodeDatabasePath(environment)
  try {
    return (await wslGatedStat(databasePath, 'scan', signal)).isFile() ? [databasePath] : []
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof WslTranscriptFsError) {
      onRefusal?.(databasePath, error)
    } else {
      onFsError?.(databasePath, error)
    }
    return []
  }
}

export async function getProcessedDatabaseInfo(
  dbPath: string,
  signal?: AbortSignal
): Promise<ZcodeUsageProcessedDatabase> {
  const dbStat = await wslGatedStat(dbPath, 'scan', signal)
  return {
    path: dbPath,
    mtimeMs: dbStat.mtimeMs,
    size: dbStat.size
  }
}
