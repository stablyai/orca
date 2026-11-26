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
        const uriPath = parseWorkspaceUrisColumn(record.workspace_uris)
        if (uriPath && uriPath.length <= MAX_PATH_LENGTH) {
          workspaceById.set(id, uriPath)
        }
        if (hasParent) {
          const parentId = extractString(record.parent_conversation_id)
          if (parentId && parentId.length <= MAX_ID_LENGTH && parentId !== id) {
            parentById.set(id, parentId)
          }
        }
      }
      for (const id of parentById.keys()) {
        if (workspaceById.has(id)) {
          continue
        }
        const inherited = resolveParentWorkspace(id, workspaceById, parentById)
        if (inherited) {
          workspaceById.set(id, inherited)
        }
      }
      return workspaceById
    }
  })
}

function parseWorkspaceUrisColumn(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined
  }
  try {
    return soleWorkspacePath(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function resolveParentWorkspace(
  startId: string,
  workspaceById: Map<string, string>,
  parentById: Map<string, string>
): string | null {
  const visited = new Set<string>([startId])
  let current = parentById.get(startId)
  while (current && !visited.has(current)) {
    const workspace = workspaceById.get(current)
    if (workspace) {
      return workspace
    }
    visited.add(current)
    current = parentById.get(current)
  }
  return null
}
