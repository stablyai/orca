import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  assertDispatchTranscriptCursor,
  matchesTerminalIdentity
} from './dispatch-transcript-segment'
import type {
  DispatchTranscriptSegment,
  DispatchTranscriptTerminalIdentity
} from './dispatch-transcript-types'

export function closeDispatchTranscriptSegment(params: {
  db: OrchestrationDb
  dispatchId: string
  endCursor: number
  terminal: DispatchTranscriptTerminalIdentity
  getSegment: (dispatchId: string) => DispatchTranscriptSegment | undefined
}): DispatchTranscriptSegment {
  assertDispatchTranscriptCursor(params.endCursor)
  params.db.db.exec('BEGIN IMMEDIATE')
  try {
    const segment = params.getSegment(params.dispatchId)
    if (
      !segment ||
      !matchesTerminalIdentity(segment, params.terminal) ||
      params.endCursor < segment.startCursor
    ) {
      throw conflict('The transcript segment close identity differs.')
    }
    if (segment.endCursor !== null && segment.endCursor !== params.endCursor) {
      throw conflict('The transcript segment already ended at another cursor.')
    }
    const lastEntry = params.db.db
      .prepare(
        'SELECT max(cursor) AS cursor FROM dispatch_transcript_entries WHERE dispatch_id = ?'
      )
      .get(params.dispatchId) as { cursor: number | null }
    if (lastEntry.cursor !== null && lastEntry.cursor >= params.endCursor) {
      throw conflict('The end cursor would truncate Dispatch transcript output.')
    }
    if (segment.endCursor === null) {
      params.db.db
        .prepare(
          `UPDATE dispatch_transcript_segments SET end_cursor = ?, updated_at = datetime('now')
           WHERE dispatch_id = ? AND end_cursor IS NULL`
        )
        .run(params.endCursor, params.dispatchId)
    }
    params.db.db.exec('COMMIT')
    return params.getSegment(params.dispatchId) as DispatchTranscriptSegment
  } catch (error) {
    params.db.db.exec('ROLLBACK')
    throw error
  }
}

function conflict(message: string): OrchestrationError {
  return new OrchestrationError('lease_identity_conflict', message)
}
