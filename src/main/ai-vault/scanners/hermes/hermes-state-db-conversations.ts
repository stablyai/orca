import type SyncDatabase from '../../../sqlite/sync-database'
import { tableExists } from '../../../opencode-usage/schema-helpers'
import { parseJsonObject } from '../../parsing/session-json-object'

// Hermes' state.db holds every surface's sessions (CLI, TUI, gateway, ACP). These rules mirror its own
// picker (hermes_state_common.py `_LISTABLE_CHILD_SQL`, `list_sessions_rich`, acp_adapter/catalog.py).

const RESET_END_REASONS = new Set([
  'session_reset',
  'session_switch',
  'idle',
  'daily',
  'suspended',
  'resume_pending_expired'
])
const LOCAL_POLICY_PREFIX = 'gateway.local_policy.v1:'

const SESSION_COLUMNS = [
  'id',
  'parent_session_id',
  'started_at',
  'source',
  'session_key',
  'model',
  'model_config',
  'cwd',
  'title',
  'ended_at',
  'end_reason',
  'last_activity_at',
  'hidden',
  'archived',
  'transcript_revision'
] as const

export type HermesSessionRow = {
  id: string
  parent_session_id: string | null
  started_at: number
  source: string | null
  session_key: string | null
  model: string | null
  model_config: string | null
  cwd: string | null
  title: string | null
  ended_at: number | null
  end_reason: string | null
  last_activity_at: number | null
  hidden: number | null
  archived: number | null
  transcript_revision: number | null
}

/** Columns differ across Hermes releases (schema 4 had no cwd, hidden or archived); read them once per open. */
export type HermesSchema = {
  sessions: ReadonlySet<string>
  messages: ReadonlySet<string>
  messageIndexes: ReadonlySet<string>
  hasStateMeta: boolean
}

export type HermesConversation = {
  /** The id Hermes' editors and `--resume` hold: a local receipt's owner, else the listed row. */
  id: string
  /** The listed segment and its compression continuations, oldest first. */
  segments: HermesSessionRow[]
}

function tableColumns(db: SyncDatabase, table: string): Set<string> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRAGMA table_info rows carry a name column.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[]
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])))
}

const schemaCache = new Map<string, { version: number; schema: HermesSchema | null }>()

/** Null when the database is not a readable Hermes session store. Cached per store until its
 *  schema_version moves: the column probes cost more than a whole preview read. */
export function readHermesSchema(db: SyncDatabase, dbPath: string): HermesSchema | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRAGMA schema_version returns one integer row.
  const version = (db.prepare('PRAGMA schema_version').get() as { schema_version: number })
    .schema_version
  const cached = schemaCache.get(dbPath)
  if (cached?.version === version) {
    return cached.schema
  }
  const schema = probeHermesSchema(db)
  schemaCache.delete(dbPath)
  schemaCache.set(dbPath, { version, schema })
  if (schemaCache.size > 32) {
    schemaCache.delete(schemaCache.keys().next().value!)
  }
  return schema
}

function probeHermesSchema(db: SyncDatabase): HermesSchema | null {
  const sessions = tableColumns(db, 'sessions')
  const messages = tableColumns(db, 'messages')
  const required =
    ['id', 'parent_session_id', 'started_at'].every((column) => sessions.has(column)) &&
    ['id', 'session_id', 'role', 'content', 'timestamp'].every((column) => messages.has(column))
  if (!required) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRAGMA index_list rows carry a name column.
  const indexes = db.prepare('PRAGMA index_list(messages)').all() as { name?: unknown }[]
  return {
    sessions,
    messages,
    messageIndexes: new Set(
      indexes.flatMap((index) => (typeof index.name === 'string' ? [index.name] : []))
    ),
    hasStateMeta: tableExists(db, 'state_meta')
  }
}

function sessionSelect(schema: HermesSchema): string {
  return SESSION_COLUMNS.map((column) =>
    schema.sessions.has(column) ? column : `NULL AS ${column}`
  ).join(', ')
}

type SessionMarkers = { branchedFrom: boolean; resetFrom: boolean; delegateFrom: boolean }

function markersOf(row: HermesSessionRow): SessionMarkers {
  const config = row.model_config ? parseJsonObject(row.model_config) : null
  const present = (key: string) => config?.[key] !== undefined && config[key] !== null
  return {
    branchedFrom: present('_branched_from'),
    resetFrom: present('_reset_from'),
    delegateFrom: present('_delegate_from')
  }
}

function isResetChild(
  row: HermesSessionRow,
  markers: SessionMarkers,
  parent: HermesSessionRow | undefined
): boolean {
  return (
    markers.resetFrom ||
    (parent !== undefined &&
      RESET_END_REASONS.has(parent.end_reason ?? '') &&
      Boolean(row.session_key) &&
      row.session_key === parent.session_key)
  )
}

function isBranchChild(
  row: HermesSessionRow,
  markers: SessionMarkers,
  parent: HermesSessionRow | undefined
): boolean {
  return (
    markers.branchedFrom ||
    (parent !== undefined &&
      parent.end_reason === 'branched' &&
      parent.ended_at !== null &&
      row.started_at >= parent.ended_at)
  )
}

function isContinuation(child: HermesSessionRow, parent: HermesSessionRow): boolean {
  const markers = markersOf(child)
  return (
    parent.end_reason === 'compression' &&
    !markers.branchedFrom &&
    !markers.delegateFrom &&
    !isResetChild(child, markers, parent) &&
    child.source !== 'tool'
  )
}

function continuationRank(row: HermesSessionRow): number {
  return row.end_reason === 'compression' ? 0 : row.ended_at === null ? 1 : 2
}

/** Hermes' own order among a compressed segment's continuations (hermes_state_compression.py
 *  `_CHAIN_STEP_SQL`): one that compressed again, else an open one, else the most recent. */
function compareContinuations(left: HermesSessionRow, right: HermesSessionRow): number {
  const activity = (row: HermesSessionRow) => Math.max(row.last_activity_at ?? 0, row.started_at)
  return (
    continuationRank(left) - continuationRank(right) ||
    activity(right) - activity(left) ||
    right.started_at - left.started_at ||
    (right.id > left.id ? 1 : right.id < left.id ? -1 : 0)
  )
}

/** A compression lineage, oldest first: the segment and the continuation each compression rotated into. */
function compressionChain(
  root: HermesSessionRow,
  childrenOf: (row: HermesSessionRow) => readonly HermesSessionRow[]
): HermesSessionRow[] {
  const chain = [root]
  const seen = new Set([root.id])
  let row: HermesSessionRow | null = root
  while (row?.end_reason === 'compression') {
    const parent: HermesSessionRow = row
    row =
      childrenOf(parent)
        .filter((child) => isContinuation(child, parent))
        .toSorted(compareContinuations)[0] ?? null
    if (!row || seen.has(row.id)) {
      break
    }
    seen.add(row.id)
    chain.push(row)
  }
  return chain
}

type LocalReceipt = { owner: string; lineage: string[] }

function parseReceipt(value: unknown): LocalReceipt | null {
  const receipt = typeof value === 'string' ? parseJsonObject(value) : null
  const owner = receipt?.session_id
  const lineage = receipt?.lineage
  if (typeof owner !== 'string' || !Array.isArray(lineage)) {
    return null
  }
  const ids = lineage.filter((id): id is string => typeof id === 'string')
  return ids.length === lineage.length ? { owner, lineage: ids } : null
}

/** A segment starts where its predecessor ended with a reset; the newest one stands for the chat. */
function resetSegmentStarts(lineage: readonly string[], endReason: (id: string) => unknown) {
  return lineage.filter(
    (_, index) => index === 0 || endReason(lineage[index - 1]) === 'session_reset'
  )
}

/** One entry per conversation Hermes' own picker lists: no hidden, archived, sub-agent, tool or continuation rows. */
export function listHermesConversations(
  db: SyncDatabase,
  schema: HermesSchema
): HermesConversation[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionSelect projects every HermesSessionRow column.
  const sessionRows = db
    .prepare(`SELECT ${sessionSelect(schema)} FROM sessions`)
    .all() as HermesSessionRow[]
  const rows = new Map(sessionRows.map((row) => [row.id, row]))
  const children = Map.groupBy(
    sessionRows.filter((row) => row.parent_session_id),
    (row) => row.parent_session_id!
  )
  const owners = new Map<string, string>()
  const superseded = new Set<string>()
  if (schema.hasStateMeta) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query projects the value column.
    const receipts = db
      .prepare('SELECT value FROM state_meta WHERE key GLOB ?')
      .all(`${LOCAL_POLICY_PREFIX}*`) as { value: unknown }[]
    for (const receipt of receipts.map(({ value }) => parseReceipt(value))) {
      if (!receipt) {
        continue
      }
      for (const id of receipt.lineage) {
        owners.set(id, receipt.owner)
      }
      const starts = resetSegmentStarts(receipt.lineage, (id) => rows.get(id)?.end_reason)
      for (const start of starts.slice(0, -1)) {
        superseded.add(start)
      }
    }
  }
  const listed: HermesConversation[] = []
  for (const row of sessionRows) {
    const markers = markersOf(row)
    const parent = row.parent_session_id ? rows.get(row.parent_session_id) : undefined
    const listable =
      !row.parent_session_id ||
      isBranchChild(row, markers, parent) ||
      isResetChild(row, markers, parent)
    // `hermes sessions list` also hides third-party tool sessions by default.
    if (
      listable &&
      !markers.delegateFrom &&
      row.source !== 'tool' &&
      Number(row.hidden ?? 0) === 0 &&
      Number(row.archived ?? 0) === 0 &&
      !superseded.has(row.id)
    ) {
      listed.push({
        id: owners.get(row.id) ?? row.id,
        segments: compressionChain(row, (segment) => children.get(segment.id) ?? [])
      })
    }
  }
  return listed
}

/** One conversation by the id its row carries, read without loading the whole store. */
export function readHermesConversation(
  db: SyncDatabase,
  schema: HermesSchema,
  id: string
): HermesConversation | null {
  const select = sessionSelect(schema)
  const byId = db.prepare(`SELECT ${select} FROM sessions WHERE id = ?`)
  const childrenOf = db.prepare(`SELECT ${select} FROM sessions WHERE parent_session_id = ?`)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionSelect projects every HermesSessionRow column.
  const row = (sessionId: string) => byId.get(sessionId) as HermesSessionRow | undefined
  let start = id
  if (schema.hasStateMeta) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query projects the value column.
    const stored = db
      .prepare('SELECT value FROM state_meta WHERE key = ?')
      .get(`${LOCAL_POLICY_PREFIX}${id}`) as { value: unknown } | undefined
    const receipt = parseReceipt(stored?.value)
    if (receipt && receipt.lineage.length > 1) {
      start = resetSegmentStarts(receipt.lineage, (segment) => row(segment)?.end_reason).at(-1)!
    }
  }
  const head = row(start)
  if (!head || Number(head.hidden ?? 0) !== 0 || Number(head.archived ?? 0) !== 0) {
    return null
  }
  return {
    id,
    segments: compressionChain(
      head,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionSelect projects every HermesSessionRow column.
      (segment) => childrenOf.all(segment.id) as HermesSessionRow[]
    )
  }
}
