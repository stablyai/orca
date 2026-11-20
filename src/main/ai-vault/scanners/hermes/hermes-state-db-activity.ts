import type SyncDatabase from '../../../sqlite/sync-database'
import type { HermesConversation } from './hermes-state-db-conversations'
import type { HermesSchema } from './hermes-state-db-schema'

// Hermes' coerce_epoch window; cells outside it are damaged pages, not times.
const EPOCH_MAX_SECONDS = 4_200_000_000

export type SegmentActivity = { live: number; maxId: number; lastMessage: number | null }

type ActivityRow = {
  session_id: string
  live: number
  max_id: number
  last_message: number | null
}

const SESSION_ID_BATCH = 500

/** Live row count, newest row id and newest message time per session, from the session index alone:
 *  an indexed search per named session, or one pass over the index when `sessionIds` is absent. */
export function readHermesSegmentActivity(
  db: SyncDatabase,
  schema: HermesSchema,
  sessionIds?: readonly string[]
): Map<string, SegmentActivity> {
  const live = schema.messages.has('active')
  // The planner otherwise picks the display index and reads every row for its timestamp (1.5 s at 200k rows).
  const index = live ? 'idx_messages_session_active' : 'idx_messages_session'
  const query = (count: number | null) => {
    const filters = [
      ...(live ? ['active = 1'] : []),
      ...(count === null
        ? []
        : [`session_id IN (${Array.from({ length: count }, () => '?').join(',')})`])
    ]
    return db.prepare(
      `SELECT session_id, COUNT(*) AS live, MAX(id) AS max_id, MAX(timestamp) AS last_message
       FROM messages ${schema.messageIndexes.has(index) ? `INDEXED BY ${index}` : ''}
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       GROUP BY session_id`
    )
  }
  const rows: ActivityRow[] = []
  if (sessionIds) {
    for (let start = 0; start < sessionIds.length; start += SESSION_ID_BATCH) {
      const batch = sessionIds.slice(start, start + SESSION_ID_BATCH)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query projects exactly these aggregates.
      rows.push(...(query(batch.length).all(...batch) as ActivityRow[]))
    }
  } else {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query projects exactly these aggregates.
    rows.push(...(query(null).all() as ActivityRow[]))
  }
  return new Map(
    rows.map((row) => [
      row.session_id,
      { live: row.live, maxId: row.max_id, lastMessage: row.last_message }
    ])
  )
}

/** How recently Hermes says a conversation was active, from its session rows alone; message
 *  timestamps can run up to a heartbeat ahead of `last_activity_at`. */
export function hermesConversationRecency(conversation: HermesConversation): number {
  return Math.max(
    ...conversation.segments.map((segment) => segment.last_activity_at ?? segment.started_at)
  )
}

export type HermesConversationActivity = {
  /** Epoch ms of the newest activity across the segments. */
  updatedMs: number
  createdMs: number
  /** Changes on any append, rewind, compaction, in-place rewrite (Hermes' conversation_revision) or metadata change. */
  revision: number
  /** Live rows across the segments; zero means nothing to show. */
  live: number
}

function epochMs(seconds: unknown): number | null {
  return typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    seconds >= 0 &&
    seconds <= EPOCH_MAX_SECONDS
    ? seconds * 1000
    : null
}

export function hermesConversationActivity(
  conversation: HermesConversation,
  activity: ReadonlyMap<string, SegmentActivity>
): HermesConversationActivity {
  const started = conversation.segments.map((segment) => epochMs(segment.started_at) ?? 0)
  let live = 0
  let maxId = 0
  let revision = 0
  let updatedMs = Math.max(...started)
  for (const segment of conversation.segments) {
    const counts = activity.get(segment.id)
    live += counts?.live ?? 0
    maxId = Math.max(maxId, counts?.maxId ?? 0)
    revision += Number(segment.transcript_revision ?? 0)
    updatedMs = Math.max(
      updatedMs,
      epochMs(segment.last_activity_at) ?? 0,
      epochMs(counts?.lastMessage) ?? 0
    )
  }
  return {
    updatedMs,
    createdMs: Math.min(...started),
    // A rename, background title, folder move or model switch moves no message; the row is read again.
    revision: fingerprint([
      live,
      maxId,
      revision,
      ...conversation.segments.flatMap((segment) => [
        segment.title ?? '',
        segment.cwd ?? '',
        segment.model ?? ''
      ])
    ]),
    live
  }
}

function fingerprint(values: readonly (number | string)[]): number {
  // FNV-1a over the parts, kept a safe integer so it round-trips through sizeBytes.
  let hash = 0x811c9dc5
  for (const char of values.join('\u0000')) {
    // A whole code point: two emoji sharing a high surrogate must still hash differently.
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}
