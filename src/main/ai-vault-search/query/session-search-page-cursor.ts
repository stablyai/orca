import { createHash } from 'node:crypto'
import type { SessionSearchRequest } from './session-search-engine-types'

export type SessionSearchCursorRejection = 'stale-generation' | 'different-query' | 'malformed'

export class SessionSearchCursorError extends Error {
  constructor(
    readonly rejection: SessionSearchCursorRejection,
    readonly actualGeneration: number,
    /** Cursor generation, or the generation at the start of a first-page read. */
    readonly expectedGeneration?: number
  ) {
    super(`Search page rejected: ${rejection}`)
    this.name = 'SessionSearchCursorError'
  }
}

type CursorPayload = {
  /** Database incarnation; changes when the index is rebuilt. */
  i: string
  /** Index generation. */
  g: number
  /** Offset into the ranked list. */
  o: number
  /** Query identity; see sessionSearchPageKey. */
  k: string
}

/** Exclude page size so callers can change it while paging through the same ranked list. */
export function sessionSearchPageKey(request: SessionSearchRequest): string {
  const filters = request.filters ?? {}
  const identity = JSON.stringify([
    request.query,
    request.scope ?? 'all',
    filters.sort ?? 'relevance',
    filters.since ?? null,
    [...(filters.agents ?? [])].sort(),
    [...(filters.scopePaths ?? [])].sort()
  ])
  return createHash('sha256').update(identity).digest('base64url').slice(0, 16)
}

export function encodeSessionSearchCursor(
  generation: number,
  offset: number,
  key: string,
  incarnation: string
): string {
  const payload: CursorPayload = { i: incarnation, g: generation, o: offset, k: key }
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
}

/** Decode the offset or reject with generation details so callers can restart stale pagination. */
export function decodeSessionSearchCursor(
  cursor: string,
  generation: number,
  key: string,
  incarnation: string
): number {
  let payload: CursorPayload
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as CursorPayload
  } catch {
    throw new SessionSearchCursorError('malformed', generation)
  }
  // Retain a valid claimed generation for diagnostics even if other fields are malformed.
  const claimed =
    typeof payload?.g === 'number' && Number.isInteger(payload.g) && payload.g >= 0
      ? payload.g
      : undefined
  if (
    claimed === undefined ||
    !Number.isInteger(payload?.o) ||
    payload.o < 0 ||
    typeof payload?.k !== 'string'
  ) {
    throw new SessionSearchCursorError('malformed', generation, claimed)
  }
  // Report snapshot changes before query changes so the caller knows to restart pagination.
  if (claimed !== generation) {
    throw new SessionSearchCursorError('stale-generation', generation, claimed)
  }
  // Cursors without incarnation fencing cannot survive a possible rebuild.
  if (payload.i !== incarnation) {
    throw new SessionSearchCursorError('stale-generation', generation, claimed)
  }
  if (payload.k !== key) {
    throw new SessionSearchCursorError('different-query', generation, claimed)
  }
  return payload.o
}
