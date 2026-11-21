// The bot work table as SQLite holds it: its schema, the columns later builds added, and its rows read.
import type { SqliteRow } from '../sqlite/sqlite-statement'
import { CONNECTOR_SOURCES } from '../../shared/connectors/external-conversation-link'
import type { BotWorkRow } from './bot-work-store'

export const BOT_WORK_CLOSE_REASONS = [
  'stopped',
  'task_gone',
  'workspace_gone',
  'thread_gone',
  'owner_reset',
  'superseded',
  'bot_gone',
  'start_failed'
] as const
export type BotWorkCloseReason = (typeof BOT_WORK_CLOSE_REASONS)[number]

export const BOT_WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_work (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  host TEXT NOT NULL,
  asked_in_app INTEGER NOT NULL DEFAULT 0,
  current INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT,
  UNIQUE (bot_id, source, external_id, generation)
);
DROP INDEX IF EXISTS bot_work_live_address;
CREATE UNIQUE INDEX IF NOT EXISTS bot_work_current_address
  ON bot_work (bot_id, source, external_id) WHERE closed_at IS NULL AND current = 1;
-- From builds that tracked each row's pull request and woke the bot on it.
DROP INDEX IF EXISTS bot_work_live_pr;
DROP TABLE IF EXISTS bot_pr_wakes;
DROP TABLE IF EXISTS bot_pr_pending;
DROP TABLE IF EXISTS bot_pr_flushed;
`

export function text(row: SqliteRow, column: string): string {
  const value = row[column]
  return typeof value === 'string' ? value : String(value ?? '')
}

export function integer(row: SqliteRow, column: string): number | null {
  const value = row[column]
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : null
}

export function rowOf(row: SqliteRow): BotWorkRow | null {
  const source = CONNECTOR_SOURCES.find((entry) => entry === row.source)
  const reason = BOT_WORK_CLOSE_REASONS.find((entry) => entry === row.close_reason) ?? null
  if (!source) {
    return null
  }
  return {
    rowId: text(row, 'id'),
    generation: integer(row, 'generation') ?? 0,
    botId: text(row, 'bot_id'),
    address: { source, externalId: text(row, 'external_id') },
    taskId: text(row, 'task_id'),
    dispatchId: text(row, 'dispatch_id'),
    host: text(row, 'host'),
    current: integer(row, 'current') !== 0,
    askedInApp: integer(row, 'asked_in_app') === 1,
    createdAt: integer(row, 'created_at') ?? 0,
    closedAt: integer(row, 'closed_at'),
    closeReason: reason
  }
}

export const ADDED_COLUMNS = [
  ['current', 'INTEGER NOT NULL DEFAULT 1'],
  ['asked_in_app', 'INTEGER NOT NULL DEFAULT 0']
] as const
