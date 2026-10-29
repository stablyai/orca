import { z } from 'zod'
import type Database from '../../../../sqlite/sync-database'
import {
  ORCHESTRATION_RUN_EVENT_PAGE_LIMIT,
  RunEventDataSchema,
  RunEventSchema,
  type RunEventsPage
} from '../../../../../shared/orchestration-run-events'
import { OrchestrationError } from '../../orchestration-error'

const CursorSchema = z.object({
  runId: z.string(),
  recordingId: z.string(),
  after: z.number().int().nonnegative().safe(),
  through: z.number().int().nonnegative().safe()
})
const CoverageSchema = z.object({
  recordingId: z.string(),
  recordedSince: z.iso.datetime(),
  completeFromCreation: z.union([z.literal(0), z.literal(1)])
})
const EventRowSchema = RunEventSchema.omit({ data: true }).extend({ data: z.string() })

export function readRunEvents(
  db: Database.Database,
  runId: string,
  options: { limit?: number; cursor?: string } = {}
): RunEventsPage {
  db.exec('SAVEPOINT read_run_events')
  try {
    const page = readSnapshot(db, runId, options)
    db.exec('RELEASE read_run_events')
    return page
  } catch (error) {
    db.exec('ROLLBACK TO read_run_events; RELEASE read_run_events')
    throw error
  }
}

function readSnapshot(
  db: Database.Database,
  runId: string,
  options: { limit?: number; cursor?: string }
): RunEventsPage {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(ORCHESTRATION_RUN_EVENT_PAGE_LIMIT)
    .parse(options.limit ?? ORCHESTRATION_RUN_EVENT_PAGE_LIMIT)
  const rawCoverage = db
    .prepare(`SELECT recording_id AS recordingId, recorded_since AS recordedSince,
    complete_from_creation AS completeFromCreation
    FROM orchestration_run_event_coverage WHERE run_id = ?`)
    .get(runId)
  if (!db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) {
    throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`)
  }
  const coverage = CoverageSchema.parse(rawCoverage)
  const watermark = z
    .object({ sequence: z.number().int().nonnegative().safe() })
    .parse(
      db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_run_events WHERE run_id = ?'
        )
        .get(runId)
    ).sequence
  let after = 0
  let through = watermark
  if (options.cursor) {
    try {
      const cursor = CursorSchema.parse(
        JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
      )
      if (
        cursor.runId !== runId ||
        cursor.recordingId !== coverage.recordingId ||
        cursor.after > cursor.through ||
        cursor.through > watermark
      ) {
        throw new Error('Cursor does not match the recorded history')
      }
      after = cursor.after
      through = cursor.through
    } catch {
      throw new OrchestrationError(
        'cursor_invalid',
        'The Run history cursor is invalid. Read the first page again.'
      )
    }
  }
  const rows = db
    .prepare(`SELECT sequence, run_id AS runId, kind, entity_id AS entityId,
    task_id AS taskId, dispatch_id AS dispatchId, recorded_at AS recordedAt, data
    FROM orchestration_run_events WHERE run_id = ? AND sequence > ? AND sequence <= ?
    ORDER BY sequence LIMIT ?`)
    .all(runId, after, through, limit + 1)
  const events = rows.slice(0, limit).map((row) => {
    const parsed = EventRowSchema.parse(row)
    return { ...parsed, data: RunEventDataSchema.parse(JSON.parse(parsed.data)) }
  })
  const last = events.at(-1)
  return {
    runId,
    coverage: {
      recordedSince: coverage.recordedSince,
      completeFromCreation: coverage.completeFromCreation === 1
    },
    events,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              runId,
              recordingId: coverage.recordingId,
              after: last.sequence,
              through
            })
          ).toString('base64url')
        : null
  }
}
