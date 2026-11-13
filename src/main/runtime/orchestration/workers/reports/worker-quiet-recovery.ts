import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  LOCAL_QUIET_NOTICE_DISPATCH,
  LOCAL_QUIET_NOTICE_PREDICATE,
  LOCAL_QUIET_NOTICE_TIME,
  RELAY_QUIET_NOTICE_PAYLOAD,
  RELAY_QUIET_NOTICE_PREDICATE,
  RELAY_QUIET_NOTICE_TIME
} from '../../db/schema/worker-quiet-notice-indexes'
import type { QuietNotice } from './worker-quiet-sweep'

/** Two indexed latest-row seeks per requested worker, including acknowledged relay notices. */
export function latestWorkerQuietNotices(
  db: OrchestrationDb,
  workers: readonly { dispatchId: string; runId: string }[]
): Map<string, QuietNotice> {
  const latest = new Map<string, QuietNotice>()
  if (workers.length === 0) {
    return latest
  }
  const rows = db.db
    .prepare(`
    WITH requested AS (
      SELECT json_extract(value, '$.dispatchId') AS dispatch_id,
        json_extract(value, '$.runId') AS run_id FROM json_each(?)
    )
    SELECT requested.dispatch_id,
      (SELECT payload FROM messages
        WHERE ${LOCAL_QUIET_NOTICE_PREDICATE}
          AND run_id = requested.run_id AND ${LOCAL_QUIET_NOTICE_DISPATCH} = requested.dispatch_id
        ORDER BY ${LOCAL_QUIET_NOTICE_TIME} DESC LIMIT 1) AS local_payload,
      (SELECT ${RELAY_QUIET_NOTICE_PAYLOAD} FROM federation_relay_items
        WHERE ${RELAY_QUIET_NOTICE_PREDICATE} AND dispatch_id = requested.dispatch_id
        ORDER BY ${RELAY_QUIET_NOTICE_TIME} DESC LIMIT 1) AS relay_payload
    FROM requested
  `)
    .all(JSON.stringify(workers))
  for (const row of rows) {
    for (const payload of [row.local_payload, row.relay_payload]) {
      if (typeof payload !== 'string') {
        continue
      }
      const notice: QuietNotice | undefined = JSON.parse(payload).quietNotice
      if (
        notice?.dispatchId === row.dispatch_id &&
        (!latest.has(notice.dispatchId) ||
          notice.observedAt > latest.get(notice.dispatchId)!.observedAt)
      ) {
        latest.set(notice.dispatchId, notice)
      }
    }
  }
  return latest
}
