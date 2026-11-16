import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultSessionDeleteRemoval } from '../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from '../../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import { yieldToEventLoop } from '../../../shared/concurrency/event-loop-yield'
import type { WorkspaceAgentHistoryTranscriptTally } from '../../../shared/workspace-agent-history/workspace-agent-history-types'
import { scanAiVaultSessions } from '../session-scanner'
import { removeAiVaultSessionPathPermanently } from '../deletion/host-session-delete'
import { removeAiVaultSessionPath } from '../deletion/session-delete'
import { isENOENT } from '../../filesystem/local-file-io/filesystem-path-containment'
import { invalidateSessionParseCacheEntry } from '../parse-cache/session-parse-cache-store'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import type { AiVaultScanOptions } from '../session-scanner-types'
import {
  createWorkspaceHistoryOwner,
  type WorkspaceHistoryOwnership
} from './workspace-history-ownership'
import { workspaceHistorySessionRemovals } from './workspace-history-removals'
import { deleteWorkspaceHistorySqliteSessions } from './workspace-history-sqlite-delete'

export type WorkspaceHistoryRequest = {
  mode: 'measure' | 'delete'
  ownership: WorkspaceHistoryOwnership
  /** A session written at or after this time may still be open; it is kept. */
  inUseSince: number
  options: Omit<AiVaultScanOptions, 'signal'>
  /** Delete only these sessions (keys from a measure the user confirmed); absent means every owned one. */
  onlySessions?: readonly string[]
}

export type WorkspaceHistoryResult = WorkspaceAgentHistoryTranscriptTally & {
  /** Transcript paths removed, for the parent's list caches and the search index. */
  deletedFilePaths: string[]
  /** Keys of the sessions a delete would remove now; a confirmed delete passes them back. */
  candidates: string[]
}

// Small batches keep each burst of unlinks short and let cancellation land between them.
const DELETE_BATCH_SIZE = 32
const SQLITE_AGENTS = new Set<AiVaultSession['agent']>(['opencode', 'opencode2', 'zcode'])

/** Scan this host's transcripts, keep only those a deleted workspace owns, then count or remove them. */
export async function runWorkspaceHistory(
  request: WorkspaceHistoryRequest,
  signal: AbortSignal
): Promise<WorkspaceHistoryResult> {
  const { scope } = request.ownership
  const scan = await scanAiVaultSessions({
    ...request.options,
    unlimited: true,
    // Chat-naming runs hold the user's first prompt, so they go with the workspace too.
    includeTextTaskRequests: true,
    // A just-deleted workspace needs only its own sessions; the full list is for already-deleted ones.
    ...(scope.kind === 'removed' ? { scopePaths: scope.paths, scopeOnly: true } : {}),
    signal
  })
  // Database child sessions are their own rows; file-backed subagents go with their parent's folder.
  const sessions = scan.sessions.filter(
    (session) =>
      session.executionHostId === LOCAL_EXECUTION_HOST_ID &&
      (!session.subagent || SQLITE_AGENTS.has(session.agent))
  )

  const owns = createWorkspaceHistoryOwner(request.ownership)
  const result: WorkspaceHistoryResult = {
    total: sessions.length,
    matched: 0,
    bytes: 0,
    inUse: 0,
    deleted: 0,
    failed: 0,
    deletedFilePaths: [],
    candidates: []
  }
  const confirmed = request.onlySessions ? new Set(request.onlySessions) : null
  const owned: AiVaultSession[] = []
  for (const [index, session] of sessions.entries()) {
    if (index % 256 === 0) {
      await yieldToEventLoop()
      throwIfAiVaultScanCancelled(signal)
    }
    if (
      (confirmed && !confirmed.has(workspaceHistorySessionKey(session))) ||
      !(await owns(session))
    ) {
      continue
    }
    result.matched++
    if (Date.parse(session.modifiedAt) >= request.inUseSince) {
      result.inUse++
      continue
    }
    owned.push(session)
  }

  const context = { options: request.options, wslHomeDirs: request.options.wslHomeDirs ?? [] }
  const sqliteRows = new Map<string, Map<string, AiVaultSession>>()
  const countedInodes = new Set<string>()
  // Re-proved uncached before each delete: a volume can disconnect or a folder come back at any time.
  const ownsNow = (session: AiVaultSession): Promise<boolean> =>
    createWorkspaceHistoryOwner(request.ownership)(session)
  for (const [index, session] of owned.entries()) {
    if (index % DELETE_BATCH_SIZE === 0) {
      await yieldToEventLoop()
      throwIfAiVaultScanCancelled(signal)
    }
    if (SQLITE_AGENTS.has(session.agent)) {
      // Database rows name the database file; the session is a row inside it.
      const row = splitOpenCodeSqliteCandidate(
        workspaceHistorySessionKey(session),
        sqliteKind(session)
      )
      if (row) {
        result.candidates.push(workspaceHistorySessionKey(session))
        const rows = sqliteRows.get(row.dbPath) ?? new Map<string, AiVaultSession>()
        rows.set(row.sessionId, session)
        sqliteRows.set(row.dbPath, rows)
        continue
      }
    }
    const removals = await workspaceHistorySessionRemovals(session, context)
    if (!removals) {
      result.failed++
      continue
    }
    // Folders count too: a recent subagent transcript or artifact means the session is still running.
    const measured = await walkRemovals(removals, countedInodes)
    if (measured.newestMtimeMs >= request.inUseSince) {
      result.inUse++
      continue
    }
    result.bytes += measured.bytes
    result.candidates.push(workspaceHistorySessionKey(session))
    if (request.mode === 'measure') {
      continue
    }
    if (!(await ownsNow(session))) {
      result.failed++
      continue
    }
    // The scan may be minutes old, and other homes' Codex copies were never scanned; look again.
    if ((await walkRemovals(removals, new Set())).newestMtimeMs >= request.inUseSince) {
      result.inUse++
      continue
    }
    throwIfAiVaultScanCancelled(signal)
    const files = removals
      .filter((removal) => removal.kind === 'file')
      .map((removal) => removal.path)
    if (await removeAll(removals, session.agent === 'codex')) {
      result.deleted++
      for (const path of new Set([session.filePath, ...files])) {
        result.deletedFilePaths.push(path)
        invalidateSessionParseCacheEntry(path)
      }
    } else {
      result.failed++
    }
  }

  for (const [dbPath, rows] of sqliteRows) {
    if (request.mode === 'measure') {
      continue
    }
    await yieldToEventLoop()
    throwIfAiVaultScanCancelled(signal)
    const outcome = await deleteWorkspaceHistorySqliteSessions(
      dbPath,
      [...rows.keys()],
      request.inUseSince,
      (sessionId) => ownsNow(rows.get(sessionId)!),
      signal
    )
    result.inUse += outcome.busy.length
    result.failed += outcome.kept.length
    for (const sessionId of outcome.deleted) {
      const rowPath = buildOpenCodeSqliteCandidatePath(dbPath, sessionId)
      result.deleted++
      result.deletedFilePaths.push(rowPath)
      invalidateSessionParseCacheEntry(rowPath)
    }
  }
  return result
}

/** A database row is keyed by database and session; a file session by its transcript path. */
function workspaceHistorySessionKey(session: AiVaultSession): string {
  return SQLITE_AGENTS.has(session.agent) &&
    !splitOpenCodeSqliteCandidate(session.filePath, sqliteKind(session))
    ? buildOpenCodeSqliteCandidatePath(session.filePath, session.sessionId)
    : session.filePath
}

function sqliteKind(session: AiVaultSession): 'opencode' | 'zcode' {
  return session.agent === 'zcode' ? 'zcode' : 'opencode'
}

// Companions go first, so a refusal part way leaves the transcript listed for a retry. Codex aliases
// are equals: every link is tried, since any survivor keeps the bytes and resurfaces the session.
async function removeAll(
  removals: readonly AiVaultSessionDeleteRemoval[],
  tryEvery: boolean
): Promise<boolean> {
  let removedAll = true
  for (const removal of removals) {
    let refused = true
    try {
      refused = Boolean(
        await removeAiVaultSessionPath(removal, removeAiVaultSessionPathPermanently)
      )
    } catch {
      // Counted as a refusal below.
    }
    if (refused) {
      removedAll = false
      if (!tryEvery) {
        return false
      }
    }
  }
  return removedAll
}

/** Bytes freed (hard links share one inode, so each counts once) and the newest write under the removals. */
async function walkRemovals(
  removals: readonly AiVaultSessionDeleteRemoval[],
  counted: Set<string>
): Promise<{ bytes: number; newestMtimeMs: number }> {
  let bytes = 0
  let newestMtimeMs = 0
  const visit = async (path: string, depth: number): Promise<void> => {
    let stats
    try {
      stats = await lstat(path)
    } catch (error) {
      // Only a missing path is idle; any other failure could hide a live file.
      if (!isENOENT(error)) {
        newestMtimeMs = Number.POSITIVE_INFINITY
      }
      return
    }
    newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs)
    const key = `${stats.dev}:${stats.ino}`
    if (stats.isFile() && !counted.has(key)) {
      counted.add(key)
      bytes += stats.size
    } else if (stats.isDirectory()) {
      let names: string[] = []
      try {
        names = await readdir(path)
      } catch {
        // An unreadable folder could hide a live file.
        newestMtimeMs = Number.POSITIVE_INFINITY
        return
      }
      // Too deep to prove idle: keep it rather than delete files nobody looked at.
      if (depth >= 8 && names.length > 0) {
        newestMtimeMs = Number.POSITIVE_INFINITY
        return
      }
      for (const name of names) {
        await visit(join(path, name), depth + 1)
      }
    }
  }
  for (const removal of removals) {
    await visit(removal.path, 0)
  }
  return { bytes, newestMtimeMs }
}
