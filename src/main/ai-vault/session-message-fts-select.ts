import type { Database } from 'fts5-sql-bundle'
import {
  isAiVaultSessionMessageRole,
  type AiVaultSessionMessageRole
} from '../../shared/ai-vault-session-message-hit'
import type { AiVaultRgSearchScope } from '../../shared/ai-vault-session-search-scope'
import {
  aiVaultFtsRolesForScope,
  buildAiVaultFtsMatchExpression,
  escapeAiVaultFtsLike
} from '../../shared/ai-vault-session-trigram-query'

export type SqlBindValue = string | number

export type MessageSearchRow = {
  id: number
  session_id: string
  role: AiVaultSessionMessageRole
  byte_offset: number
  line_number: number
  text: string
  snippet: string
  file_path: string
}

export function selectSqlJsAll(
  db: Database,
  sql: string,
  params: readonly SqlBindValue[]
): Record<string, unknown>[] {
  const statement = db.prepare(sql)
  try {
    statement.bind([...params])
    const rows: Record<string, unknown>[] = []
    while (statement.step()) {
      rows.push(Object.fromEntries(Object.entries(statement.getAsObject())))
    }
    return rows
  } finally {
    statement.free()
  }
}

export function readSqlString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

export function readSqlNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function searchMessageFtsMatch(
  db: Database,
  segments: readonly string[],
  searchScope: AiVaultRgSearchScope,
  sessionIds: readonly string[],
  limit: number
): MessageSearchRow[] {
  const roles = aiVaultFtsRolesForScope(searchScope)
  const sessionPlaceholders = sessionIds.map(() => '?').join(', ')
  const roleSql = roles ? `AND m.role IN (${roles.map(() => '?').join(', ')})` : ''
  return selectSqlJsAll(
    db,
    `SELECT m.id, m.session_id, m.role, m.byte_offset, m.line_number, m.text,
            snippet(messages_fts, 0, '', '', '…', 16) AS snippet,
            m.file_path
     FROM messages_fts
     JOIN messages m ON m.id = messages_fts.rowid
     JOIN sessions s ON s.id = m.session_id
     WHERE messages_fts MATCH ? AND m.session_id IN (${sessionPlaceholders}) ${roleSql}
     ORDER BY bm25(messages_fts)
     LIMIT ?`,
    [buildAiVaultFtsMatchExpression(segments), ...sessionIds, ...(roles ?? []), limit]
  ).flatMap((row) => {
    const parsed = parseMessageSearchRow(row)
    return parsed ? [parsed] : []
  })
}

export function searchMessageFtsLike(
  db: Database,
  segments: readonly string[],
  searchScope: AiVaultRgSearchScope,
  sessionIds: readonly string[],
  limit: number
): MessageSearchRow[] {
  const roles = aiVaultFtsRolesForScope(searchScope)
  const sessionPlaceholders = sessionIds.map(() => '?').join(', ')
  const likeSql = segments.map(() => `m.text LIKE ? ESCAPE '\\'`).join(' AND ')
  const roleSql = roles ? `AND m.role IN (${roles.map(() => '?').join(', ')})` : ''
  return selectSqlJsAll(
    db,
    `SELECT m.id, m.session_id, m.role, m.byte_offset, m.line_number, m.text,
            m.text AS snippet, m.file_path
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE ${likeSql} AND m.session_id IN (${sessionPlaceholders}) ${roleSql}
     ORDER BY m.id
     LIMIT ?`,
    [
      ...segments.map((segment) => `%${escapeAiVaultFtsLike(segment)}%`),
      ...sessionIds,
      ...(roles ?? []),
      limit
    ]
  ).flatMap((row) => {
    const parsed = parseMessageSearchRow(row)
    return parsed ? [parsed] : []
  })
}

function parseMessageSearchRow(row: Record<string, unknown>): MessageSearchRow | null {
  const id = readSqlNumber(row, 'id')
  const sessionId = readSqlString(row, 'session_id')
  const role = row.role
  const byteOffset = readSqlNumber(row, 'byte_offset')
  const lineNumber = readSqlNumber(row, 'line_number')
  const text = readSqlString(row, 'text')
  const snippet = readSqlString(row, 'snippet')
  const filePath = readSqlString(row, 'file_path')
  if (
    id === null ||
    sessionId === null ||
    !isAiVaultSessionMessageRole(role) ||
    byteOffset === null ||
    lineNumber === null ||
    text === null ||
    snippet === null ||
    filePath === null
  ) {
    return null
  }
  return {
    id,
    session_id: sessionId,
    role,
    byte_offset: byteOffset,
    line_number: lineNumber,
    text,
    snippet,
    file_path: filePath
  }
}
