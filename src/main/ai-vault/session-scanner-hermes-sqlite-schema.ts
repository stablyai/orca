import type SyncDatabase from '../sqlite/sync-database'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { asRecord, extractString } from './session-scanner-values'

export type SessionRow = {
  id: string
  title: string | null
  directory: string | null
  model: string | null
  createdAt: number
  updatedAt: number
}
const PREVIEW_TEXT_LIMIT = 256 * 1024

export function timestampMs(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  const ms = Number.isFinite(numeric)
    ? numeric < 1e11
      ? numeric * 1000
      : numeric
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : 0
}

export function sessionRow(value: unknown): SessionRow | null {
  const row = asRecord(value)
  if (!row || typeof row.id !== 'string' || !row.id) {
    return null
  }
  const createdAt = timestampMs(row.created_at)
  return {
    id: row.id,
    title: extractString(row.title),
    directory: extractString(row.directory),
    model: extractString(row.model),
    createdAt,
    updatedAt: timestampMs(row.updated_at) || createdAt
  }
}

function column(db: SyncDatabase, table: string, name: string): string {
  return columnExists(db, table, name) ? name : 'NULL'
}

function firstColumn(db: SyncDatabase, names: string[]): string {
  return names.find((name) => columnExists(db, 'sessions', name)) ?? 'NULL'
}

export function sessionColumns(
  db: SyncDatabase
): { id: string; select: string; updated: string } | null {
  if (!tableExists(db, 'sessions')) {
    return null
  }
  const id = firstColumn(db, ['id', 'session_id'])
  if (id === 'NULL') {
    return null
  }
  const created = firstColumn(db, ['started_at', 'created_at', 'session_start'])
  const activity = ['last_activity_at', 'ended_at', 'updated_at', 'last_updated'].filter((name) =>
    columnExists(db, 'sessions', name)
  )
  const updated = activity.length ? `COALESCE(${[...activity, created].join(', ')})` : created
  return {
    id,
    updated,
    select: `${id} AS id, ${column(db, 'sessions', 'title')} AS title,
      ${column(db, 'sessions', 'cwd')} AS directory, ${column(db, 'sessions', 'model')} AS model,
      ${created} AS created_at, ${updated} AS updated_at`
  }
}

export function canReadMessages(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'messages') &&
    columnExists(db, 'messages', 'session_id') &&
    columnExists(db, 'messages', 'role') &&
    columnExists(db, 'messages', 'content')
  )
}

export function visibility(db: SyncDatabase, alias: string): string {
  const active = columnExists(db, 'messages', 'active')
    ? `AND (${alias}.active = 1${columnExists(db, 'messages', 'compacted') ? ` OR ${alias}.compacted = 1` : ''})`
    : ''
  const hidden = columnExists(db, 'messages', 'display_kind')
    ? `AND COALESCE(${alias}.display_kind, '') <> 'hidden'`
    : ''
  return `${active} ${hidden}`
}

export function messagePredicate(db: SyncDatabase): string {
  const hasDisplayOrder =
    columnExists(db, 'messages', 'display_order') &&
    columnExists(db, 'messages', 'id') &&
    columnExists(db, 'messages', 'active')
  // Upstream display history chooses the live/newest row for each display-order group.
  return `${visibility(db, 'm')}${
    hasDisplayOrder
      ? ` AND (m.display_order IS NULL OR m.id = (
    SELECT candidate.id FROM messages candidate
    WHERE candidate.session_id = m.session_id AND candidate.display_order = m.display_order
      ${visibility(db, 'candidate')}
    ORDER BY candidate.active DESC, candidate.id DESC LIMIT 1))`
      : ''
  }`
}

export function sessionVisibility(db: SyncDatabase): string {
  return ['hidden', 'archived']
    .filter((name) => columnExists(db, 'sessions', name))
    .map((name) => `AND COALESCE(${name}, 0) = 0`)
    .join(' ')
}

function messageOrder(db: SyncDatabase, direction: 'ASC' | 'DESC'): string {
  const id = columnExists(db, 'messages', 'id') ? 'm.id' : 'm.rowid'
  return columnExists(db, 'messages', 'display_order')
    ? `COALESCE(m.display_order, ${id}) ${direction}, ${id} ${direction}`
    : `${id} ${direction}`
}

export function messageQuery(db: SyncDatabase, full: boolean, firstUser = false): string {
  const content = full
    ? 'm.content'
    : `CAST(substr(CAST(m.content AS BLOB), 1, ${PREVIEW_TEXT_LIMIT}) AS TEXT)`
  const truncated = full ? '0' : `length(CAST(m.content AS BLOB)) > ${PREVIEW_TEXT_LIMIT}`
  return `SELECT m.role, ${content} AS content, ${truncated} AS content_truncated, ${column(db, 'messages', 'timestamp')} AS timestamp,
    ${full ? column(db, 'messages', 'tool_calls') : 'NULL'} AS tool_calls
    FROM messages m WHERE m.session_id = ? ${messagePredicate(db)}
    ${firstUser ? "AND m.role = 'user'" : full ? '' : "AND m.role IN ('user','assistant') AND m.content IS NOT NULL AND m.content <> ''"}
    ORDER BY ${messageOrder(db, firstUser || full ? 'ASC' : 'DESC')} LIMIT ?`
}
