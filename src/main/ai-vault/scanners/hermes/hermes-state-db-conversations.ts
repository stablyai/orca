import type SyncDatabase from '../../../sqlite/sync-database'
import { parseJsonObject } from '../../parsing/session-json-object'
import { sessionSelect, type HermesSchema, type HermesSessionRow } from './hermes-state-db-schema'

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

export type HermesConversation = {
  /** The id Hermes' editors and `--resume` hold: a local receipt's owner, else the listed row. */
  id: string
  /** The listed segment and its compression continuations, oldest first. */
  segments: HermesSessionRow[]
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

type SessionRowSource = {
  row: (id: string) => HermesSessionRow | undefined
  children: (row: HermesSessionRow) => readonly HermesSessionRow[]
}

/** Local reset lineages list as one conversation: the owner of each segment, and the earlier
 *  segments that no longer list (hermes_state_local.local_lineage_index). */
function readLocalLineages(db: SyncDatabase, schema: HermesSchema, source: SessionRowSource) {
  const owners = new Map<string, string>()
  const superseded = new Set<string>()
  if (!schema.hasStateMeta) {
    return { owners, superseded }
  }
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
    const starts = resetSegmentStarts(receipt.lineage, (id) => source.row(id)?.end_reason)
    for (const start of starts.slice(0, -1)) {
      superseded.add(start)
    }
  }
  return { owners, superseded }
}

/** One entry per conversation Hermes' own picker lists: no hidden, archived, sub-agent, tool or
 *  continuation rows. With `recent`, only conversations among the `recent` most recently active
 *  session rows, found through Hermes' own recency index without reading every row. */
export function listHermesConversations(
  db: SyncDatabase,
  schema: HermesSchema,
  recent?: number
): HermesConversation[] {
  const select = sessionSelect(schema)
  let starts: HermesSessionRow[]
  let source: SessionRowSource
  if (recent === undefined || !schema.sessions.has('last_activity_at')) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionSelect projects every HermesSessionRow column.
    starts = db.prepare(`SELECT ${select} FROM sessions`).all() as HermesSessionRow[]
    const rows = new Map(starts.map((row) => [row.id, row]))
    const children = Map.groupBy(
      starts.filter((row) => row.parent_session_id),
      (row) => row.parent_session_id!
    )
    source = { row: (id) => rows.get(id), children: (row) => children.get(row.id) ?? [] }
  } else {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionSelect projects every HermesSessionRow column.
    const newest = db
      .prepare(
        `SELECT ${select} FROM sessions
         ORDER BY COALESCE(last_activity_at, started_at) DESC, started_at DESC LIMIT ?`
      )
      .all(recent) as HermesSessionRow[]
    source = lazySessionRows(db, select, newest)
    // A recent continuation stands for the conversation it continues.
    const heads = new Map<string, HermesSessionRow>()
    for (let row of newest) {
      const walked = new Set([row.id])
      let parent = row.parent_session_id ? source.row(row.parent_session_id) : undefined
      while (parent && !walked.has(parent.id) && isContinuation(row, parent)) {
        walked.add(parent.id)
        row = parent
        parent = row.parent_session_id ? source.row(row.parent_session_id) : undefined
      }
      heads.set(row.id, row)
    }
    starts = [...heads.values()]
  }
  const { owners, superseded } = readLocalLineages(db, schema, source)
  return starts.flatMap((row) => {
    const markers = markersOf(row)
    const parent = row.parent_session_id ? source.row(row.parent_session_id) : undefined
    const listable =
      !row.parent_session_id ||
      isBranchChild(row, markers, parent) ||
      isResetChild(row, markers, parent)
    // `hermes sessions list` also hides third-party tool sessions by default.
    return listable &&
      !markers.delegateFrom &&
      row.source !== 'tool' &&
      Number(row.hidden ?? 0) === 0 &&
      Number(row.archived ?? 0) === 0 &&
      !superseded.has(row.id)
      ? [{ id: owners.get(row.id) ?? row.id, segments: compressionChain(row, source.children) }]
      : []
  })
}

/** Session rows read on demand by id and by parent, seeded with rows already read. */
function lazySessionRows(
  db: SyncDatabase,
  select: string,
  seed: readonly HermesSessionRow[]
): SessionRowSource {
  const rows = new Map<string, HermesSessionRow | undefined>(seed.map((row) => [row.id, row]))
  const byId = db.prepare(`SELECT ${select} FROM sessions WHERE id = ?`)
  const byParent = db.prepare(`SELECT ${select} FROM sessions WHERE parent_session_id = ?`)
  return {
    row: (id) => {
      if (!rows.has(id)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionSelect projects every HermesSessionRow column.
        rows.set(id, byId.get(id) as HermesSessionRow | undefined)
      }
      return rows.get(id)
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessionSelect projects every HermesSessionRow column.
    children: (row) => byParent.all(row.id) as HermesSessionRow[]
  }
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
