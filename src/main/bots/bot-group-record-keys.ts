import {
  isJson,
  keptEntryId,
  keptGroup,
  keptMessage,
  KEEPS_KEYS,
  marked,
  parsedRecord,
  withUnreadEntries,
  type Json
} from './bot-group-newer-keys'

// What a group or post record gets back after a release that predates KEEPS_KEYS rewrote it: its
// schema strips the keys it doesn't know. The database keeps the record as it was before that
// release's first rewrite; a build that knows the marker reads the record with what was dropped
// put back, so whatever it then writes already holds it, and that write drops the saved copy.
// Only the record being read is ever repaired, never a backlog.

const MARK = `{"${KEEPS_KEYS}":true`

type ListLevel = {
  key: string
  id: readonly string[]
  /** What a release before the marker (v1.4.265 to v1.4.271) may not know on an entry. */
  dropped: readonly string[]
}

type RecordLevel = { dropped: readonly string[]; lists: readonly ListLevel[] }

const MESSAGE: RecordLevel = {
  dropped: [
    'images',
    'remoteAsks',
    'handoffs',
    'mentioned',
    'pausedAfter',
    'automationRun',
    'fromItems',
    'fromReports',
    'memorySource',
    'triggeredBy'
  ],
  lists: [
    {
      key: 'turns',
      id: ['operationId'],
      dropped: ['answer', 'handedOff', 'mailed', 'avatarOutfit', 'failure']
    },
    { key: 'remoteAsks', id: ['requestId'], dropped: ['avatarOutfit', 'failure'] }
  ]
}

const ROSTER_ID = ['environmentId', 'botId'] as const
const GROUP: RecordLevel = {
  dropped: ['remoteMembers'],
  lists: [{ key: 'remoteMembers', id: ROSTER_ID, dropped: ['avatarOutfit'] }]
}

const LEVELS = { bot_groups: GROUP, bot_group_messages: MESSAGE } as const
export type BotGroupRecordTable = keyof typeof LEVELS

/** A record row as the store reads it: the record, its saved copy and, for a group, the paired
 *  members an older release couldn't see. */
export type SavedRow = { record?: unknown; saved?: unknown; hidden?: unknown }

/** `stored` with what `before` had that the rewrite dropped. A failure code names its error, so
 *  it comes back only beside the same error. */
function withDropped(stored: Json, before: Json, dropped: readonly string[]): Json {
  const back = { ...stored }
  for (const key of dropped) {
    if (
      !Object.hasOwn(stored, key) &&
      Object.hasOwn(before, key) &&
      (key !== 'failure' || stored.error === before.error)
    ) {
      back[key] = before[key]
    }
  }
  return back
}

function withDroppedEntries(record: Json, before: Json, list: ListLevel): Json {
  const now = record[list.key]
  const then = before[list.key]
  if (!Array.isArray(now) || !Array.isArray(then)) {
    return record
  }
  const byId = new Map(then.map((entry) => [keptEntryId(entry, list.id), entry]))
  const priorMailTurn =
    list.key === 'turns' && now.length === 1 && then.length === 1 ? then[0] : undefined
  const entries = now.map((entry) => {
    if (!isJson(entry)) {
      return entry
    }
    const key = keptEntryId(entry, list.id)
    const was = key === null ? null : byId.get(key)
    if (isJson(was)) {
      return withDropped(entry, was, list.dropped)
    }
    // A retry changes the operation ID but keeps the mail line's avatar snapshot.
    if (
      entry.mailbox === true &&
      isJson(priorMailTurn) &&
      priorMailTurn.mailbox === true &&
      entry.sessionId === priorMailTurn.sessionId &&
      entry.botId === priorMailTurn.botId
    ) {
      return withDropped(entry, priorMailTurn, ['avatarOutfit'])
    }
    return entry
  })
  return { ...record, [list.key]: entries }
}

/** The group's paired members with those an older release couldn't see first, unless one is
 *  among them again. */
function withHidden(record: Json, hidden: unknown): Json {
  const members = parsedList(hidden)
  if (members.length === 0) {
    return record
  }
  const now = Array.isArray(record.remoteMembers) ? record.remoteMembers : []
  return { ...record, remoteMembers: withUnreadEntries(now, members, ROSTER_ID) }
}

function parsedList(text: unknown): unknown[] {
  try {
    const list: unknown = typeof text === 'string' ? JSON.parse(text) : []
    return Array.isArray(list) ? list.filter(isJson) : []
  } catch {
    return []
  }
}

function withDroppedKeys(table: BotGroupRecordTable, record: Json, row: SavedRow): Json {
  const before = parsedRecord(row.saved)
  if (!before) {
    return record
  }
  const level = LEVELS[table]
  let back = withDropped(record, before, level.dropped)
  for (const list of level.lists) {
    back = withDroppedEntries(back, before, list)
  }
  return table === 'bot_groups' ? withHidden(back, row.hidden) : back
}

/** A stored record as this build reads it: what an older release dropped put back. */
export function readRecord(table: BotGroupRecordTable, row: SavedRow): unknown {
  const record: unknown = JSON.parse(String(row.record))
  return isJson(record) ? withDroppedKeys(table, record, row) : record
}

/** Keep unknown keys relative to the recovered row the caller saw before editing. */
export function writtenRecord(
  table: BotGroupRecordTable,
  record: Json,
  row: SavedRow | undefined
): string {
  const stored = parsedRecord(row?.record)
  const before = stored && row ? withDroppedKeys(table, stored, row) : stored
  return marked(table === 'bot_groups' ? keptGroup(before, record) : keptMessage(before, record))
}

const withSaved = (table: BotGroupRecordTable) =>
  `LEFT JOIN bot_group_dropped d ON d.table_name = '${table}' AND d.id = ${table}.id`

/** The store's reads and rewrites of records. */
export const RECORD_SQL = {
  readGroups: `SELECT bot_groups.record, d.record AS saved, d.hidden
  FROM bot_groups ${withSaved('bot_groups')}`,
  readMessages: `SELECT sequence, bot_group_messages.record, d.record AS saved
  FROM bot_group_messages ${withSaved('bot_group_messages')}`,
  putGroup: `INSERT INTO bot_groups(id, record) VALUES (?, ?)
  ON CONFLICT(id) DO UPDATE SET record = excluded.record`,
  updateMessage: 'UPDATE bot_group_messages SET record = ? WHERE id = ? AND group_id = ?'
}

/** v1.4.270 and v1.4.271's, the releases before the marker that know paired members. */
const PAIRED_RELEASE_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity',
  'cursor',
  'hermes',
  'copilot',
  'opencode2',
  'kimi',
  'kiro',
  'aug',
  'goose',
  'kilo',
  'mimo-code',
  'gemini',
  'droid',
  'qwen-code'
]
  .map((agent) => `'${agent}'`)
  .join(', ')

const memberId = (entry: string) =>
  `CASE WHEN ${entry}.type = 'object'
    THEN json_array(${entry}.value ->> '$.environmentId', ${entry}.value ->> '$.botId') END`

/**
 * For a group, per rewrite by a release that knows paired members: when the roster it read had a
 * member with an agent it doesn't know, it read the roster as none, so the members it didn't
 * write are hidden from it, not removed. A member it writes is no longer hidden. The legacy
 * keep-field trigger's own UPDATE has no old array, so it never changes which members were hidden.
 */
const HIDE_MEMBERS = `UPDATE bot_group_dropped SET hidden = (
    SELECT json_group_array(json(v)) FROM (
      SELECT h.value AS v, ${memberId('h')} AS k FROM json_each(coalesce(hidden, '[]')) h
      UNION ALL
      SELECT o.value, ${memberId('o')} FROM json_each(OLD.record, '$.remoteMembers') o
      WHERE o.type = 'object' AND EXISTS (
        SELECT 1 FROM json_each(OLD.record, '$.remoteMembers') u
        WHERE coalesce(OLD.record ->> (u.fullkey || '.agent'), '') NOT IN (${PAIRED_RELEASE_AGENTS})))
    WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.record, '$.remoteMembers') n
      WHERE n.type = 'object' AND ${memberId('n')} = k))
  WHERE table_name = 'bot_groups' AND id = NEW.id
    AND CASE WHEN json_valid(NEW.record) AND json_valid(OLD.record)
      THEN json_type(NEW.record, '$.remoteMembers') = 'array'
        AND json_type(OLD.record, '$.remoteMembers') = 'array'
      ELSE 0 END;`

const unmarked = (record: string) => `substr(${record}, 1, ${MARK.length}) IS NOT '${MARK}'`

/** Keeps, per record, its text before an older release's first rewrite; a marked rewrite or a
 *  delete drops it. The marker is found without parsing the record. */
export const SAVE_DROPPED = [
  `CREATE TABLE IF NOT EXISTS bot_group_dropped (table_name TEXT NOT NULL, id TEXT NOT NULL,
    record TEXT NOT NULL, hidden TEXT, PRIMARY KEY (table_name, id))`,
  ...Object.keys(LEVELS).flatMap((table) => [
    `CREATE TRIGGER IF NOT EXISTS ${table}_save_dropped AFTER UPDATE OF record ON ${table}
      WHEN ${unmarked('NEW.record')}
      BEGIN
        -- No OR IGNORE: the rewrite's own conflict clause would override it.
        INSERT INTO bot_group_dropped(table_name, id, record) SELECT '${table}', OLD.id, OLD.record
        WHERE NOT EXISTS (SELECT 1 FROM bot_group_dropped WHERE table_name = '${table}' AND id = OLD.id);
        ${table === 'bot_groups' ? HIDE_MEMBERS : ''}
      END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_clear_dropped AFTER UPDATE OF record ON ${table}
      WHEN NOT ${unmarked('NEW.record')}
      BEGIN DELETE FROM bot_group_dropped WHERE table_name = '${table}' AND id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_delete_dropped AFTER DELETE ON ${table}
      BEGIN DELETE FROM bot_group_dropped WHERE table_name = '${table}' AND id = OLD.id; END`
  ])
]
