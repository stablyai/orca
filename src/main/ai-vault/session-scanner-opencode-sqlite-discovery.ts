import { basename, extname, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import { cachedOpenCodeSqliteCandidates } from './session-scanner-opencode-sqlite-cached-candidates'
import type {
  FileWithMtime,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'
import type { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'

// Why: keep the SQLite discovery + dedup layer separate from the parser so
// each file stays under the max-lines lint rule and the discovery layer can
// be tested in isolation. The SQLite list query + reader now lives in
// session-scanner-opencode-sqlite-list.ts (re-exported below so existing
// callers/tests keep importing it from here) and runs on a worker thread.

// Re-exported: the pure list reader moved to its own electron-free module so the
// worker entry can import it without the worker client's Electron dependency.
export { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'

// Why: the scan budget covers SQLite work only, so it runs while this leg is in
// flight and is banked again the moment it settles.
async function listWithinScanBudget(args: {
  context: OpenCodeSqliteScanContext
  dbPaths: readonly string[]
  limitPerAgent: number
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
}): Promise<SessionFileCandidate[]> {
  // An already-terminated scan (cooldown, or a sibling source that crashed the
  // shared context) has no budget to spend; don't round-trip the worker to be
  // told so. Replay what the parse cache already knows instead of dropping every
  // SQLite-backed session for the duration of the backoff — the listing is still
  // unreconciled, which is what markSqliteListCancelled tells the user.
  if (args.context.isTerminated) {
    if (args.dbPaths.length === 0) {
      return []
    }
    args.context.markSqliteListCancelled()
    return cachedOpenCodeSqliteCandidates({
      dbPaths: args.dbPaths,
      platform: args.platform,
      limit: args.limitPerAgent
    })
  }
  args.context.armDeadline()
  try {
    const candidates = await listOpenCodeSqliteSessionsViaWorker({
      context: args.context,
      dbPaths: args.dbPaths,
      limit: args.limitPerAgent,
      issues: args.issues
    })
    // A sibling source can terminate the shared context after this list already
    // answered; completed live work remains authoritative.
    if (candidates.length > 0) {
      return candidates
    }
    if (args.context.isTerminated || args.context.metrics().sqliteListCancelled) {
      args.context.markSqliteListCancelled()
      return cachedOpenCodeSqliteCandidates({
        dbPaths: args.dbPaths,
        platform: args.platform,
        limit: args.limitPerAgent
      })
    }
    return []
  } finally {
    args.context.pauseDeadline()
  }
}

// Why: extract the sessionId from a legacy file path like
// storage/session/<projectId>/<sessionId>.json. Falls back to the filename
// without extension when the opencode id format doesn't match a UUID.
function sessionIdFromLegacyFilePath(filePath: string): string {
  return basename(filePath, extname(filePath))
}

/**
 * Discover OpenCode sessions from both the legacy file layout and the SQLite
 * DB, deduplicating at the file level before parsing. On mixed installs the
 * same session may appear once via a stale legacy JSON file and once via the
 * SQLite DB; SQLite is the source of truth on 1.17.x, so file-based entries
 * whose sessionId matches a SQLite entry are dropped. Legacy installs without
 * the `session` table fall through to the file scanner unchanged.
 * @param args.storageDir - Root of the OpenCode storage directory (contains `session/` and `message/`).
 * @param args.dbPaths - Absolute paths to opencode.db files to scan.
 * @param args.limitPerAgent - Maximum number of candidates per source.
 * @param args.platform - Platform the parse cache entries were produced on.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns A `SessionFileDiscovery` with deduplicated file entries.
 */
export async function discoverOpenCodeSessions(args: {
  context: OpenCodeSqliteScanContext
  storageDir: string
  dbPaths: readonly string[]
  limitPerAgent: number
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery> {
  if (args.dbPaths.length > 0) {
    args.context.markSqliteSourcePresent()
  }
  const [fileDiscovery, sqliteCandidates] = await Promise.all([
    discoverFiles({
      rootDir: join(args.storageDir, 'session'),
      limit: args.limitPerAgent,
      agent: 'opencode',
      issues: args.issues,
      extensions: ['.json']
    }),
    // Why (#8864): the SQLite list leg runs on a worker thread; only this leg
    // moves off the main thread, the filesystem scan stays inline.
    listWithinScanBudget(args)
  ])

  const sqliteFiles = sqliteCandidates.map((c) => c.file)
  // Why: on mixed installs the same OpenCode session may appear once via the
  // SQLite DB and once via a stale legacy JSON file. SQLite is the source of
  // truth on 1.17.x, so drop file-based duplicates when a SQLite entry with
  // the same sessionId already exists. Deduping at the file level also avoids
  // parsing the same session twice.
  if (sqliteFiles.length === 0) {
    // An empty list from a terminated scan is not "no SQLite sessions": the
    // legacy files below were never reconciled against the DB, so say so rather
    // than presenting possibly-stale JSON rows as the whole truth. A source with
    // no DB at all had nothing to reconcile, so it stays quiet even when another
    // source terminated the shared context.
    if (args.dbPaths.length > 0 && args.context.isTerminated) {
      args.context.markSqliteListCancelled()
    }
    return {
      agent: 'opencode' as const,
      rootDir: fileDiscovery.rootDir,
      files: fileDiscovery.files
    }
  }
  const sqliteSessionIds = new Set<string>()
  for (const file of sqliteFiles) {
    const parsed = splitOpenCodeSqliteCandidate(file.path)
    if (parsed) {
      sqliteSessionIds.add(parsed.sessionId)
    }
  }
  const dedupedFileDiscovery: FileWithMtime[] = []
  for (const file of fileDiscovery.files) {
    if (!sqliteSessionIds.has(sessionIdFromLegacyFilePath(file.path))) {
      dedupedFileDiscovery.push(file)
    }
  }

  return {
    agent: 'opencode' as const,
    rootDir: fileDiscovery.rootDir,
    files: [...dedupedFileDiscovery, ...sqliteFiles]
  }
}
