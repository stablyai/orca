import { createHash } from 'node:crypto'
import type { SessionSearchRequest } from './session-search-engine-types'

export type SessionSearchCursorRejection = 'stale-generation' | 'different-query' | 'malformed'

/**
 * A cursor the engine refuses to honour. Typed, and thrown rather than
 * swallowed: silently restarting at page one hands the caller a page it has
 * already shown as if it were the next one, and silently re-running against a
 * newer index hands it a slice of a list it never saw.
 */
export class SessionSearchCursorError extends Error {
  constructor(readonly rejection: SessionSearchCursorRejection) {
    super(`Search cursor rejected: ${rejection}`)
    this.name = 'SessionSearchCursorError'
  }
}

type CursorPayload = {
  /** Index generation. */
  g: number
  /** Offset into the ranked list. */
  o: number
  /** Query identity; see `sessionSearchPageKey`. */
  k: string
}

/**
 * Everything a page's ranking depends on except the limit. Two requests with
 * the same key produce the same ranked list within one generation, so a cursor
 * minted by one is meaningful to the other; the limit is left out on purpose so
 * a caller may change its page size mid-pagination.
 */
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

export function encodeSessionSearchCursor(generation: number, offset: number, key: string): string {
  const payload: CursorPayload = { g: generation, o: offset, k: key }
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
}

/** The offset this cursor points at, or a typed rejection. */
export function decodeSessionSearchCursor(cursor: string, generation: number, key: string): number {
  let payload: CursorPayload
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as CursorPayload
  } catch {
    throw new SessionSearchCursorError('malformed')
  }
  if (
    typeof payload?.g !== 'number' ||
    !Number.isInteger(payload?.o) ||
    payload.o < 0 ||
    typeof payload?.k !== 'string'
  ) {
    throw new SessionSearchCursorError('malformed')
  }
  // Generation first: a caller who changed the query AND waited through a
  // publish should hear about the index moving, which is the condition it
  // cannot fix by paging again.
  if (payload.g !== generation) {
    throw new SessionSearchCursorError('stale-generation')
  }
  if (payload.k !== key) {
    throw new SessionSearchCursorError('different-query')
  }
  return payload.o
}
