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
// put back, and its next rewrite of the record stores that and drops the saved copy. So only
// the record being read or written is ever repaired, never a backlog.

const MARK = `{"${KEEPS_KEYS}":true`

type ListLevel = {
  key: string
  id: readonly string[]
  /** What a release before the marker (v1.4.265 to v1.4.271) may not know on an entry. */
  dropped: readonly string[]
  /** The agents those releases read: a list with another one reads as none there, so the
   *  entries that release never wrote come back beside what it wrote. */
  agents?: readonly string[]
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

const ROSTER: ListLevel = {
  key: 'remoteMembers',
  id: ['environmentId', 'botId'],
  dropped: ['avatarOutfit'],
  agents: PAIRED_RELEASE_AGENTS
}

const GROUP: RecordLevel = { dropped: ['remoteMembers'], lists: [ROSTER] }

const LEVELS = { bot_groups: GROUP, bot_group_messages: MESSAGE } as const
export type BotGroupRecordTable = keyof typeof LEVELS

/** A record row as the store reads it, with WITH_SAVED's columns. */
export type SavedRow = { record?: unknown; saved?: unknown; seen?: unknown }

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

function withDroppedEntries(
  record: Json,
  before: Json,
  list: ListLevel,
  seen: ReadonlySet<string | null>
): Json {
  const now = record[list.key]
  const then = before[list.key]
  if (!Array.isArray(now) || !Array.isArray(then)) {
    return record
  }
  const byId = new Map(then.map((entry) => [keptEntryId(entry, list.id), entry]))
  const entries = now.map((entry) => {
    const key = keptEntryId(entry, list.id)
    const was = key === null ? null : byId.get(key)
    return isJson(entry) && isJson(was) ? withDropped(entry, was, list.dropped) : entry
  })
  const agents = list.agents
  const unread =
    agents && then.some((entry) => !isJson(entry) || !agents.includes(String(entry.agent)))
  return {
    ...record,
    [list.key]: unread ? withUnreadEntries(entries, then, list.id, seen) : entries
  }
}

function seenIds(seen: unknown): Set<string | null> {
  try {
    const ids: unknown = typeof seen === 'string' ? JSON.parse(seen) : []
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** `record` with what an older release's rewrites dropped from the saved copy, if there is one. */
function withDroppedKeys(table: BotGroupRecordTable, record: Json, row: SavedRow): Json {
  const before = parsedRecord(row.saved)
  if (!before) {
    return record
  }
  const level = LEVELS[table]
  const seen = seenIds(row.seen)
  let back = withDropped(record, before, level.dropped)
  for (const list of level.lists) {
    back = withDroppedEntries(back, before, list, seen)
  }
  return back
}

/** A stored record as this build reads it: what an older release dropped put back. */
export function readRecord(table: BotGroupRecordTable, row: SavedRow): unknown {
  const record: unknown = JSON.parse(String(row.record))
  return isJson(record) ? withDroppedKeys(table, record, row) : record
}

/** What this build writes over a stored row: with what a newer build stored on it, and what an
 *  older release dropped from it, since this write drops the saved copy. */
export function writtenRecord(
  table: BotGroupRecordTable,
  record: Json,
  row: SavedRow | undefined
): string {
  const stored = parsedRecord(row?.record)
  const kept = table === 'bot_groups' ? keptGroup(stored, record) : keptMessage(stored, record)
  return marked(row ? withDroppedKeys(table, kept, row) : kept)
}

/** Joins each record's saved copy to a read of `table`, whose rows then carry `saved` and `seen`. */
const withSaved = (table: BotGroupRecordTable) =>
  `LEFT JOIN bot_group_dropped d ON d.table_name = '${table}' AND d.id = ${table}.id`

/** The store's reads and rewrites of records. */
export const RECORD_SQL = {
  readGroups: `SELECT bot_groups.record, d.record AS saved, d.seen
  FROM bot_groups ${withSaved('bot_groups')}`,
  readMessages: `SELECT sequence, bot_group_messages.record, d.record AS saved
  FROM bot_group_messages ${withSaved('bot_group_messages')}`,
  putGroup: `INSERT INTO bot_groups(id, record) VALUES (?, ?)
  ON CONFLICT(id) DO UPDATE SET record = excluded.record`,
  updateMessage: 'UPDATE bot_group_messages SET record = ? WHERE id = ? AND group_id = ?'
}

const unmarked = (record: string) => `substr(${record}, 1, ${MARK.length}) IS NOT '${MARK}'`

/** For a group: the paired members each unmarked rewrite wrote, so one it later removed stays
 *  removed. Group records are small, so this one reads JSON. */
const SEEN_MEMBERS = `UPDATE bot_group_dropped SET seen = (
    SELECT json_group_array(id) FROM (
      SELECT value AS id FROM json_each(coalesce(seen, '[]'))
      UNION
      SELECT json_array(m.value ->> '$.environmentId', m.value ->> '$.botId')
      FROM json_each(NEW.record, '$.remoteMembers') m WHERE m.type = 'object'))
  WHERE table_name = 'bot_groups' AND id = NEW.id
    AND CASE WHEN json_valid(NEW.record) THEN json_type(NEW.record, '$.remoteMembers') = 'array' ELSE 0 END;`

/** Keeps, per record, its text before an older release's first rewrite; a marked rewrite or a
 *  delete drops it. The marker is found without parsing the record. */
export const SAVE_DROPPED = [
  `CREATE TABLE IF NOT EXISTS bot_group_dropped (table_name TEXT NOT NULL, id TEXT NOT NULL,
    record TEXT NOT NULL, seen TEXT, PRIMARY KEY (table_name, id))`,
  ...Object.keys(LEVELS).flatMap((table) => [
    `CREATE TRIGGER IF NOT EXISTS ${table}_save_dropped AFTER UPDATE OF record ON ${table}
      WHEN ${unmarked('NEW.record')}
      BEGIN
        -- No OR IGNORE: the rewrite's own conflict clause would override it.
        INSERT INTO bot_group_dropped(table_name, id, record) SELECT '${table}', OLD.id, OLD.record
        WHERE NOT EXISTS (SELECT 1 FROM bot_group_dropped WHERE table_name = '${table}' AND id = OLD.id);
        ${table === 'bot_groups' ? SEEN_MEMBERS : ''}
      END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_clear_dropped AFTER UPDATE OF record ON ${table}
      WHEN NOT ${unmarked('NEW.record')}
      BEGIN DELETE FROM bot_group_dropped WHERE table_name = '${table}' AND id = NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_delete_dropped AFTER DELETE ON ${table}
      BEGIN DELETE FROM bot_group_dropped WHERE table_name = '${table}' AND id = OLD.id; END`
  ])
]
