import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultSessionDeleteRemoval } from '../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { splitOpenCodeSqliteCandidate } from '../../../shared/agent-session/lifecycle/provider-handles/opencode-sqlite-session-path'
import { yieldToEventLoop } from '../../../shared/concurrency/event-loop-yield'
import type { WorkspaceAgentHistoryTranscriptTally } from '../../../shared/workspace-agent-history/workspace-agent-history-types'
import { scanAiVaultSessions } from '../session-scanner'
import { removeAiVaultSessionPathPermanently } from '../deletion/host-session-delete'
import { removeAiVaultSessionPath } from '../deletion/session-delete'
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
}

export type WorkspaceHistoryResult = WorkspaceAgentHistoryTranscriptTally & {
  /** Transcript paths removed, for the parent's list caches and the search index. */
  deletedFilePaths: string[]
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
    // A just-deleted workspace needs only its own sessions; the full list is for already-deleted ones.
    ...(scope.kind === 'removed' ? { scopePaths: scope.paths, scopeOnly: true } : {}),
    signal
  })
  const sessions = scan.sessions.filter(
    (session) => session.executionHostId === LOCAL_EXECUTION_HOST_ID && !session.subagent
  )
  const owns = createWorkspaceHistoryOwner(request.ownership)
  const result: WorkspaceHistoryResult = {
    total: sessions.length,
    matched: 0,
    bytes: 0,
    inUse: 0,
    deleted: 0,
    failed: 0,
    deletedFilePaths: []
  }
  const owned: AiVaultSession[] = []
  for (const [index, session] of sessions.entries()) {
    if (index % 256 === 0) {
      await yieldToEventLoop()
      throwIfAiVaultScanCancelled(signal)
    }
    if (!(await owns(session))) {
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
  for (const [index, session] of owned.entries()) {
    if (index % DELETE_BATCH_SIZE === 0) {
      await yieldToEventLoop()
      throwIfAiVaultScanCancelled(signal)
    }
    if (SQLITE_AGENTS.has(session.agent)) {
      const row = splitOpenCodeSqliteCandidate(
        session.filePath,
        session.agent === 'zcode' ? 'zcode' : 'opencode'
      )
      if (row) {
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
    const bytes = await measureRemovals(removals, countedInodes)
    result.bytes += bytes
    if (request.mode === 'measure') {
      continue
    }
    if (await removeAll(removals)) {
      result.deleted++
      result.deletedFilePaths.push(session.filePath)
      invalidateSessionParseCacheEntry(session.filePath)
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
    const outcome = deleteWorkspaceHistorySqliteSessions(dbPath, [...rows.keys()])
    result.inUse += outcome.busy.length
    for (const sessionId of outcome.deleted) {
      const session = rows.get(sessionId)!
      result.deleted++
      result.deletedFilePaths.push(session.filePath)
      invalidateSessionParseCacheEntry(session.filePath)
    }
  }
  return result
}

// Companions go first, so a refusal part way leaves the transcript listed for a retry.
async function removeAll(removals: readonly AiVaultSessionDeleteRemoval[]): Promise<boolean> {
  try {
    for (const removal of removals) {
      if (await removeAiVaultSessionPath(removal, removeAiVaultSessionPathPermanently)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** Bytes freed: hard links share one inode, so each is counted once. */
async function measureRemovals(
  removals: readonly AiVaultSessionDeleteRemoval[],
  counted: Set<string>
): Promise<number> {
  let bytes = 0
  const visit = async (path: string, depth: number): Promise<void> => {
    let stats
    try {
      stats = await lstat(path)
    } catch {
      return
    }
    const key = `${stats.dev}:${stats.ino}`
    if (stats.isFile() && !counted.has(key)) {
      counted.add(key)
      bytes += stats.size
    } else if (stats.isDirectory() && depth < 8) {
      let names: string[] = []
      try {
        names = await readdir(path)
      } catch {
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
  return bytes
}
