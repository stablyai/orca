import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  decodeDispatchTranscriptCursor,
  encodeDispatchTranscriptCursor
} from './dispatch-transcript-cursor'
import type {
  DispatchTranscriptEntry,
  DispatchTranscriptReadResult,
  DispatchTranscriptReadSelector,
  DispatchTranscriptSegment
} from './dispatch-transcript-types'

const DEFAULT_READ_LIMIT = 100
const MAX_READ_LIMIT = 200
const MAX_HISTORY_DEPTH = 1_000

export function readDispatchTranscript(params: {
  db: OrchestrationDb
  dispatchId: string
  selector?: DispatchTranscriptReadSelector
  cursor?: string
  limit?: number
  getSegment: (dispatchId: string) => DispatchTranscriptSegment | undefined
}): DispatchTranscriptReadResult {
  const selector = params.selector ?? { kind: 'active' }
  const segments = selectSegments(params.dispatchId, selector, params.getSegment)
  const limit = clampLimit(params.limit)
  const decoded = decodeDispatchTranscriptCursor(params.cursor, params.dispatchId, selector) ?? {
    segmentIndex: 0,
    position: segments[0]!.startCursor
  }
  if (decoded.segmentIndex >= segments.length) {
    throw new OrchestrationError('cursor_invalid', 'The transcript cursor is out of range.')
  }
  const collected: (DispatchTranscriptEntry & { segmentIndex: number })[] = []
  for (let index = decoded.segmentIndex; index < segments.length; index += 1) {
    const segment = segments[index]!
    const position = index === decoded.segmentIndex ? decoded.position : segment.startCursor
    const remaining = limit + 1 - collected.length
    const rows = params.db.db
      .prepare(
        `SELECT cursor, payload_json FROM dispatch_transcript_entries
         WHERE dispatch_id = ? AND cursor >= ? AND cursor >= ?
           AND (? IS NULL OR cursor < ?)
         ORDER BY cursor LIMIT ?`
      )
      .all(
        segment.dispatchId,
        position,
        segment.startCursor,
        segment.endCursor,
        segment.endCursor,
        remaining
      ) as { cursor: number; payload_json: string }[]
    collected.push(
      ...rows.map((row) => ({
        dispatchId: segment.dispatchId,
        cursor: row.cursor,
        payload: JSON.parse(row.payload_json) as unknown,
        segmentIndex: index
      }))
    )
    if (collected.length >= limit + 1) {
      break
    }
  }
  const returned = collected.slice(0, limit)
  const last = returned.at(-1)
  const continuation = last
    ? { segmentIndex: last.segmentIndex, position: last.cursor + 1 }
    : decoded
  return {
    dispatchId: params.dispatchId,
    selector,
    segments,
    entries: returned.map(({ segmentIndex: _segmentIndex, ...entry }) => entry),
    continuation: {
      cursor: encodeDispatchTranscriptCursor({
        dispatchId: params.dispatchId,
        selector,
        ...continuation
      }),
      hasMore: collected.length > limit,
      limit,
      returnedCount: returned.length
    }
  }
}

function selectSegments(
  dispatchId: string,
  selector: DispatchTranscriptReadSelector,
  getSegment: (dispatchId: string) => DispatchTranscriptSegment | undefined
): DispatchTranscriptSegment[] {
  const active = getSegment(dispatchId)
  if (!active) {
    throw new OrchestrationError(
      'operation_unknown',
      `Dispatch transcript segment ${dispatchId} was not found.`
    )
  }
  if (selector.kind === 'active') {
    return [active]
  }
  const ancestry: DispatchTranscriptSegment[] = []
  const seen = new Set<string>()
  let segment: DispatchTranscriptSegment | undefined = active
  while (segment) {
    if (seen.has(segment.dispatchId) || ancestry.length >= MAX_HISTORY_DEPTH) {
      throw conflict('Dispatch transcript ancestry is invalid.')
    }
    seen.add(segment.dispatchId)
    ancestry.push(segment)
    segment = segment.predecessorDispatchId ? getSegment(segment.predecessorDispatchId) : undefined
  }
  if (selector.kind === 'all') {
    return ancestry.toReversed()
  }
  const predecessor = ancestry.slice(1).find((entry) => entry.dispatchId === selector.dispatchId)
  if (!predecessor) {
    throw new OrchestrationError(
      'invalid_argument',
      'The requested Dispatch is not a predecessor of the active segment.'
    )
  }
  return [predecessor]
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_READ_LIMIT
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new OrchestrationError('invalid_argument', 'Transcript read limit must be positive.')
  }
  return Math.min(limit, MAX_READ_LIMIT)
}

function conflict(message: string): OrchestrationError {
  return new OrchestrationError('lease_identity_conflict', message)
}
