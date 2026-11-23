// Item rows as SQLite holds them, read loosely: a field a later build wrote, or one it can't read,
// falls back instead of throwing.
import type { SqliteRow } from '../sqlite/sqlite-statement'
import {
  BOT_ITEM_EVENT_KINDS,
  BOT_ITEM_LINK_KINDS,
  BOT_ITEM_STATUSES,
  botItemEventId,
  type BotItemActor,
  type BotItemEvent,
  type BotItemChatKind,
  type BotItemStatus
} from '../../shared/bots/bot-items'
import type {
  BotItemEventRecord,
  BotItemLinkRecord,
  BotItemMadeBy,
  BotItemRecord,
  BotItemSource
} from './bot-items-schema'

export function text(row: SqliteRow, column: string): string {
  const value = row[column]
  return typeof value === 'string' ? value : String(value ?? '')
}

export function optionalText(row: SqliteRow, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

export function integer(row: SqliteRow, column: string): number {
  const value = row[column]
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0
}

export function optionalInteger(row: SqliteRow, column: string): number | null {
  const value = row[column]
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : null
}

export function json(row: SqliteRow, column: string): unknown {
  const raw = optionalText(row, column)
  if (raw === null) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function statusOf(value: unknown): BotItemStatus {
  return BOT_ITEM_STATUSES.find((entry) => entry === value) ?? 'planned'
}

const CHAT_KINDS: readonly BotItemChatKind[] = ['home', 'chat', 'thread', 'automation']

function sourceOf(value: unknown): BotItemSource {
  const fields = record(value)
  const kind = CHAT_KINDS.find((entry) => entry === fields?.kind) ?? 'chat'
  return { kind, title: str(fields?.title) }
}

function madeByOf(value: unknown): BotItemMadeBy | null {
  const fields = record(value)
  const botId = str(fields?.botId)
  const chatId = str(fields?.chatId)
  return botId && chatId ? { botId, chatId } : null
}

function actorOf(value: unknown): BotItemActor {
  const fields = record(value)
  if (fields?.kind === 'bot') {
    return { kind: 'bot', botId: str(fields.botId) ?? '', chatId: str(fields.chatId) ?? '' }
  }
  if (fields?.kind === 'owner') {
    const device = str(fields.device)
    return device ? { kind: 'owner', device } : { kind: 'owner' }
  }
  return { kind: 'orca', why: str(fields?.why) ?? 'orca' }
}

export function itemRecordOf(row: SqliteRow): BotItemRecord {
  return {
    uid: text(row, 'uid'),
    number: integer(row, 'number'),
    ownerBotId: text(row, 'owner_bot_id'),
    chatId: text(row, 'chat_id'),
    source: sourceOf(json(row, 'source')),
    madeBy: madeByOf(json(row, 'made_by')),
    title: text(row, 'title'),
    description: optionalText(row, 'description'),
    doneMeans: optionalText(row, 'done_means'),
    status: statusOf(row.status),
    questionEvent: optionalInteger(row, 'question_event'),
    closeNote: optionalText(row, 'close_note'),
    snoozedUntil: optionalInteger(row, 'snoozed_until'),
    version: integer(row, 'version'),
    lastEventId: integer(row, 'last_event_id'),
    lastActivityAt: integer(row, 'last_activity_at'),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    closedAt: optionalInteger(row, 'closed_at')
  }
}

export function linkRecordOf(row: SqliteRow): BotItemLinkRecord | null {
  const kind = BOT_ITEM_LINK_KINDS.find((entry) => entry === row.kind)
  if (!kind) {
    return null
  }
  return {
    itemUid: text(row, 'item_uid'),
    kind,
    ref: text(row, 'ref'),
    addedEvent: integer(row, 'added_event')
  }
}

export function eventRecordOf(row: SqliteRow): BotItemEventRecord {
  return {
    id: integer(row, 'id'),
    itemUid: text(row, 'item_uid'),
    kind: text(row, 'kind'),
    actor: actorOf(json(row, 'actor')),
    data: record(json(row, 'data')) ?? {},
    createdAt: integer(row, 'created_at')
  }
}

/** An event as clients read it. */
export function eventViewOf(event: BotItemEventRecord): BotItemEvent {
  return {
    id: botItemEventId(event.id),
    kind: BOT_ITEM_EVENT_KINDS.find((kind) => kind === event.kind) ?? 'edited',
    actor: event.actor,
    data: event.data,
    at: event.createdAt
  }
}
