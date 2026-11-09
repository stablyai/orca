import { fileURLToPath } from 'node:url'
import { columnExists, tableExists } from '../../../opencode-usage/schema-helpers'
import { readOpenCodeDatabase } from '../opencode/sqlite/session-scanner-opencode-sqlite-open'
import { asRecord } from '../../session-scanner-record-value'
import { extractString } from '../../session-scanner-values'

// Antigravity CLI replaced history.jsonl with this SQLite index; it alone records every conversation's workspace.
const SUMMARIES_TABLE = 'conversation_summaries'
const MAX_SUMMARY_ROWS = 10_000

export function antigravityConversationSummariesPath(historyPath: string): string {
  return historyPath.replace(/history\.jsonl$/, 'conversation_summaries.db')
}

/** Map each conversation to its first local workspace; a missing table or column yields an empty map. */
export function readAntigravityConversationWorkspaces(dbPath: string): Map<string, string> {
  return readOpenCodeDatabase({
    dbPath,
    read: (db) => {
      const workspaces = new Map<string, string>()
      if (
        !tableExists(db, SUMMARIES_TABLE) ||
        !columnExists(db, SUMMARIES_TABLE, 'conversation_id') ||
        !columnExists(db, SUMMARIES_TABLE, 'workspace_uris')
      ) {
        return workspaces
      }
      const rows = db
        .prepare(
          `SELECT conversation_id, workspace_uris FROM ${SUMMARIES_TABLE} LIMIT ${MAX_SUMMARY_ROWS}`
        )
        .all()
      for (const row of rows) {
        const record = asRecord(row)
        const id = record ? extractString(record.conversation_id) : null
        const workspace = record ? firstWorkspacePath(record.workspace_uris) : null
        if (id && id.length <= 512 && workspace) {
          workspaces.set(id, workspace)
        }
      }
      return workspaces
    }
  })
}

export function firstWorkspacePath(workspaceUris: unknown): string | null {
  let uris: unknown
  try {
    uris = typeof workspaceUris === 'string' ? JSON.parse(workspaceUris) : null
  } catch {
    return null
  }
  if (!Array.isArray(uris)) {
    return null
  }
  for (const uri of uris) {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) {
      continue
    }
    try {
      const path = fileURLToPath(uri)
      if (path && path.length <= 4096) {
        return path
      }
    } catch {
      // A host-qualified URI is not a path on this platform.
    }
  }
  return null
}
