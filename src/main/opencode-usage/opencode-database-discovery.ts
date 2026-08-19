import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { resolveOpenCodeDataDirectory } from '../opencode/opencode-data-directory'
import type { OpenCodeUsageProcessedDatabase } from './types'

type OpenCodeDatabaseOverride = {
  isConfigured: boolean
  path: string | null
}

function getOpenCodeDatabaseOverride(dataDirectory: string): OpenCodeDatabaseOverride {
  const raw = process.env.OPENCODE_DB?.trim()
  if (!raw) {
    return { isConfigured: false, path: null }
  }
  if (raw === ':memory:') {
    return { isConfigured: true, path: null }
  }
  return {
    isConfigured: true,
    path: isAbsolute(raw) ? raw : join(dataDirectory, raw)
  }
}

// Why gated: the AI Vault's primary OpenCode source delegates here from inside
// its discovery fan-out, so a UNC data dir or a UNC OPENCODE_DB on a stalled
// distro would otherwise hang the whole scan on a raw syscall (STA-4049).
export async function listOpenCodeDatabases(
  /** Lets a caller report the refusal; an empty list otherwise reads as
   *  "OpenCode not used" rather than "we could not look". */
  onRefusal?: (path: string, error: WslTranscriptFsError) => void
): Promise<string[]> {
  const dataDirectory = resolveOpenCodeDataDirectory()
  const databaseOverride = getOpenCodeDatabaseOverride(dataDirectory)
  if (databaseOverride.isConfigured) {
    if (!databaseOverride.path) {
      return []
    }
    try {
      return (await wslGatedStat(databaseOverride.path, 'scan')).isFile()
        ? [databaseOverride.path]
        : []
    } catch (error) {
      reportRefusal(databaseOverride.path, error, onRefusal)
      return []
    }
  }

  try {
    const entries = await wslGatedReaddir(dataDirectory, 'scan')
    return entries
      .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(dataDirectory, entry.name))
      .sort()
  } catch (error) {
    reportRefusal(dataDirectory, error, onRefusal)
    return []
  }
}

function reportRefusal(
  path: string,
  error: unknown,
  onRefusal?: (path: string, error: WslTranscriptFsError) => void
): void {
  if (error instanceof WslTranscriptFsError) {
    onRefusal?.(path, error)
  }
}

export function compareOpenCodeClaimPriority(left: string, right: string): number {
  // Why: the canonical opencode.db is the live database; it must claim
  // duplicated sessions ahead of stale sibling copies. Remaining ties use
  // path order so ownership is deterministic across rescans.
  const leftRank = basename(left).toLowerCase() === 'opencode.db' ? 0 : 1
  const rightRank = basename(right).toLowerCase() === 'opencode.db' ? 0 : 1
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  return left < right ? -1 : left > right ? 1 : 0
}

export async function getProcessedDatabaseInfo(
  dbPath: string
): Promise<OpenCodeUsageProcessedDatabase> {
  const dbStat = await stat(dbPath)
  return {
    path: dbPath,
    mtimeMs: dbStat.mtimeMs,
    size: dbStat.size
  }
}
