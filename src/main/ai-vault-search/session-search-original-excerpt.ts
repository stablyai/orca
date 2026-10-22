import type SyncDatabase from '../sqlite/sync-database'
import { ownRetainedString } from '../../shared/own-retained-string'
import {
  paletteTranscriptLiteralOccurrences,
  type PaletteTranscriptSourceBoundaries,
  preparePaletteTranscriptProofQuery
} from '../../shared/palette-transcript-literal'
import type { SessionSearchScope } from './session-search-engine-types'

export const ORIGINAL_EXCERPT_POINTS = 512
// Indexed conversation chunks are at most 8,000 code units; tool rows are smaller.
const INDEXED_COLUMN_POINTS = 8000

type Context = PaletteTranscriptSourceBoundaries & {
  text: string
  anchors: number
  span: number
  start: number
}

/** Prefer context the renderer can prove, while preserving one contiguous source slice. */
export function selectOriginalExcerpt(
  text: string,
  query: string,
  boundaries: PaletteTranscriptSourceBoundaries = {}
): Context {
  const points = /[\u{10000}-\u{10FFFF}]/u.test(text) ? Array.from(text) : null
  let occurrences = paletteTranscriptLiteralOccurrences(
    text,
    preparePaletteTranscriptProofQuery(query),
    boundaries
  )
  if (points) {
    const pointOffsets = new Int32Array(text.length + 1)
    let offset = 0
    for (const [index, point] of points.entries()) {
      pointOffsets[offset] = index
      offset += point.length
    }
    pointOffsets[text.length] = points.length
    occurrences = occurrences.map((range) => ({
      ...range,
      start: pointOffsets[range.start],
      end: pointOffsets[range.end]
    }))
  }
  occurrences.sort((a, b) => a.end - b.end || a.start - b.start)
  let best = { anchors: 0, span: Infinity, start: 0 }
  const latest = new Map<number, number>()
  for (const occurrence of occurrences) {
    latest.set(occurrence.group, Math.max(latest.get(occurrence.group) ?? -1, occurrence.start))
    for (const [group, start] of latest) {
      if (occurrence.end - start > ORIGINAL_EXCERPT_POINTS - 16) {
        latest.delete(group)
      }
    }
    if (!latest.size) {
      continue
    }
    const start = Math.min(...latest.values())
    const span = occurrence.end - start
    if (latest.size > best.anchors || (latest.size === best.anchors && span < best.span)) {
      best = { anchors: latest.size, span, start }
    }
  }
  const length = points?.length ?? text.length
  const start = Math.max(0, Math.min(best.start - 16, length - ORIGINAL_EXCERPT_POINTS))
  return {
    text: ownRetainedString(
      points
        ? points.slice(start, start + ORIGINAL_EXCERPT_POINTS).join('')
        : text.slice(start, start + ORIGINAL_EXCERPT_POINTS)
    ),
    startsMessage: boundaries.startsMessage === true && start === 0,
    endsMessage: boundaries.endsMessage === true && start + ORIGINAL_EXCERPT_POINTS >= length,
    anchors: best.anchors,
    span: best.span,
    start
  }
}

/** Reads only the selected indexed row, with the same live-session fence as snippets. */
export function sessionSearchOriginalExcerpt(
  db: SyncDatabase,
  scope: SessionSearchScope,
  rowid: number,
  query: string,
  retentionCutoffMs: number | null
): ({ text: string } & PaletteTranscriptSourceBoundaries) | undefined {
  const columns =
    scope === 'conversation'
      ? ['user_text', 'assistant_text']
      : ['user_text', 'assistant_text', 'tool_text']
  const row = db
    .prepare(
      `SELECT m.source_boundaries, ${columns.map((column) => `substr(f.${column}, 1, ${INDEXED_COLUMN_POINTS}) AS ${column}`).join(', ')}
     FROM messages_fts f
     JOIN messages m ON m.id = f.rowid
     JOIN sessions s ON s.id = m.session_row_id
     WHERE f.rowid = ? AND (? IS NULL OR EXISTS
       (SELECT 1 FROM files WHERE session_row_id = s.id AND mtime_ms >= ?))`
    )
    .get(rowid, retentionCutoffMs, retentionCutoffMs)
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  let best: Context | undefined
  for (const column of columns) {
    const value = row[column]
    if (typeof value !== 'string' || !value) {
      continue
    }
    const flags = typeof row.source_boundaries === 'number' ? row.source_boundaries : 0
    const context = selectOriginalExcerpt(value, query, {
      startsMessage: (flags & 1) !== 0,
      endsMessage: (flags & 2) !== 0
    })
    if (
      !best ||
      context.anchors > best.anchors ||
      (context.anchors === best.anchors && context.span < best.span)
    ) {
      best = context
    }
  }
  return best?.text
    ? { text: best.text, startsMessage: best.startsMessage, endsMessage: best.endsMessage }
    : undefined
}
