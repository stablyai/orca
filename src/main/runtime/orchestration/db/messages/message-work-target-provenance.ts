import {
  ResolvedBotWorkTargetPlacementSchema,
  type ResolvedBotWorkTargetPlacement
} from '../../../../../shared/agent-session/work-target/agent-session-work-target'
import type { OrchestrationDb } from '../orchestration-db'

/** Durable host-authored work-target provenance for targeted follow-up mail; survives restarts. */
export const MESSAGE_WORK_TARGET_PROVENANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS message_work_target_provenance (
  message_id     TEXT PRIMARY KEY,
  source_origin  TEXT NOT NULL,
  placement_json TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export type MessageWorkTargetProvenanceRead =
  | { kind: 'absent' }
  | { kind: 'valid'; sourceOrigin: string; placement: ResolvedBotWorkTargetPlacement }
  | { kind: 'corrupt'; reason: string }

export function recordMessageWorkTargetProvenance(
  db: OrchestrationDb,
  messageId: string,
  sourceOrigin: string,
  placement: ResolvedBotWorkTargetPlacement
): void {
  db.db
    .prepare(
      `INSERT INTO message_work_target_provenance (message_id, source_origin, placement_json)
       VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         source_origin = excluded.source_origin,
         placement_json = excluded.placement_json`
    )
    .run(messageId, sourceOrigin, JSON.stringify(placement))
}

function parseProvenanceRow(row: {
  source_origin: string
  placement_json: string
}): MessageWorkTargetProvenanceRead {
  try {
    const raw: unknown = JSON.parse(row.placement_json)
    const parsed = ResolvedBotWorkTargetPlacementSchema.safeParse(raw)
    if (!parsed.success) {
      return { kind: 'corrupt', reason: 'Stored work-target provenance failed validation.' }
    }
    return {
      kind: 'valid',
      sourceOrigin: row.source_origin,
      placement: parsed.data
    }
  } catch {
    return { kind: 'corrupt', reason: 'Stored work-target provenance JSON is unreadable.' }
  }
}

export function readMessageWorkTargetProvenance(
  db: OrchestrationDb,
  messageId: string
): MessageWorkTargetProvenanceRead {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of two TEXT columns by primary key.
  const row = db.db
    .prepare(
      `SELECT source_origin, placement_json FROM message_work_target_provenance WHERE message_id = ?`
    )
    .get(messageId) as { source_origin: string; placement_json: string } | undefined
  return row ? parseProvenanceRow(row) : { kind: 'absent' }
}

export function readMessagesWorkTargetProvenance(
  db: OrchestrationDb,
  messageIds: readonly string[]
): Map<string, MessageWorkTargetProvenanceRead> {
  const result = new Map<string, MessageWorkTargetProvenanceRead>()
  if (messageIds.length === 0) {
    return result
  }
  const uniqueIds = [...new Set(messageIds)]
  const placeholders = uniqueIds.map(() => '?').join(',')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of three TEXT columns by primary key set.
  const rows = db.db
    .prepare(
      `SELECT message_id, source_origin, placement_json
         FROM message_work_target_provenance
        WHERE message_id IN (${placeholders})`
    )
    .all(...uniqueIds) as {
    message_id: string
    source_origin: string
    placement_json: string
  }[]
  for (const row of rows) {
    result.set(row.message_id, parseProvenanceRow(row))
  }
  return result
}
