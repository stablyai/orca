import { isWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { extractString } from '../../../../shared/text/trimmed-string'
import { wslGatedStat } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
import { columnExists, tableExists } from '../../../opencode-usage/schema-helpers'
import { isSqliteAvailable } from '../../../sqlite/sync-database'
import { asRecord } from '../../parsing/session-record-fields'
import { throwIfAiVaultScanCancelled } from '../../scan-lifecycle/ai-vault-scan-cancellation'
import { readOpenCodeDatabase } from '../opencode/sqlite/session-scanner-opencode-sqlite-open'
import { MAX_INDEX_ENTRIES, soleWorkspacePath } from './session-scanner-antigravity-metadata'

const SUMMARY_TABLE = 'conversation_summaries'
const MAX_ID_LENGTH = 512
const MAX_PATH_LENGTH = 4096

/** Read workspace URIs from Antigravity Desktop's conversation_summaries.db without locking writers. */
export async function readLocalAntigravitySummaryWorkspaces(
  dbPath: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  throwIfAiVaultScanCancelled(signal)
  if (!isSqliteAvailable()) {
    return new Map()
  }
  try {
    if (isWslUncPath(dbPath)) {
      const stats = await wslGatedStat(dbPath, 'scan', signal)
      if (!stats.isFile()) {
        return new Map()
      }
    }
    return readAntigravitySummaryWorkspacesFromDb(dbPath)
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return new Map()
  }
}

function readAntigravitySummaryWorkspacesFromDb(dbPath: string): Map<string, string> {
  return readOpenCodeDatabase({
    dbPath,
    read: (db) => {
      const workspaceById = new Map<string, string>()
      if (
        !tableExists(db, SUMMARY_TABLE) ||
        !columnExists(db, SUMMARY_TABLE, 'conversation_id') ||
        !columnExists(db, SUMMARY_TABLE, 'workspace_uris')
      ) {
        return workspaceById
      }
      const hasParent = columnExists(db, SUMMARY_TABLE, 'parent_conversation_id')
      const parentById = new Map<string, string>()
      const statement = db.prepare(
        `SELECT conversation_id, workspace_uris${hasParent ? ', parent_conversation_id' : ''} FROM ${SUMMARY_TABLE} LIMIT ?`
      )
      for (const row of statement.all(MAX_INDEX_ENTRIES)) {
        const record = asRecord(row)
        const id = record ? extractString(record.conversation_id) : null
        if (!record || !id || id.length > MAX_ID_LENGTH) {
          continue
        }
        const parsed = parseWorkspaceUrisColumn(record.workspace_uris)
        if (parsed.kind === 'resolved' && parsed.path.length <= MAX_PATH_LENGTH) {
          workspaceById.set(id, parsed.path)
        } else if (parsed.kind === 'empty' && hasParent) {
          const parentId = extractString(record.parent_conversation_id)
          if (parentId && parentId.length <= MAX_ID_LENGTH && parentId !== id) {
            parentById.set(id, parentId)
          }
        }
      }
      const memo = new Map<string, string | null>()
      for (const id of parentById.keys()) {
        if (workspaceById.has(id)) {
          continue
        }
        const inherited = resolveParentWorkspace(id, workspaceById, parentById, memo)
        if (inherited) {
          workspaceById.set(id, inherited)
        }
      }
      return workspaceById
    }
  })
}

type ParsedWorkspaceUris =
  | { kind: 'empty' }
  | { kind: 'resolved'; path: string }
  | { kind: 'explicit-unresolved' }

function parseWorkspaceUrisColumn(raw: unknown): ParsedWorkspaceUris {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { kind: 'empty' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'explicit-unresolved' }
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    return { kind: 'empty' }
  }
  const uriPath = soleWorkspacePath(parsed)
  return uriPath ? { kind: 'resolved', path: uriPath } : { kind: 'explicit-unresolved' }
}

function resolveParentWorkspace(
  startId: string,
  workspaceById: Map<string, string>,
  parentById: Map<string, string>,
  memo: Map<string, string | null>
): string | null {
  const path: string[] = []
  const visited = new Set<string>()
  let current: string | undefined = startId
  let result: string | null = null
  while (current && !visited.has(current)) {
    if (memo.has(current)) {
      result = memo.get(current) ?? null
      break
    }
    const workspace = workspaceById.get(current)
    if (workspace) {
      result = workspace
      break
    }
    visited.add(current)
    path.push(current)
    current = parentById.get(current)
  }
  for (const id of path) {
    memo.set(id, result)
  }
  return result
}
