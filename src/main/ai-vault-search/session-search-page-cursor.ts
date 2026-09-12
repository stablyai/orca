import { createHash } from 'node:crypto'
import type { SessionSearchRequest } from './session-search-engine-types'

export type SessionSearchCursorRejection = 'stale-generation' | 'different-query' | 'malformed'

/** Rejects invalid cursors or any page whose generation changes during its reads. */
export class SessionSearchCursorError extends Error {
  constructor(
    readonly rejection: SessionSearchCursorRejection,
    /** The generation observed when rejecting the request. */
    readonly actualGeneration: number,
    /** Cursor generation, or the generation at the start of a first-page read. */
    readonly expectedGeneration?: number
  ) {
    super(`Search page rejected: ${rejection}`)
    this.name = 'SessionSearchCursorError'
  }
}

type CursorPayload = {
  /** Index generation. */
  g: number
  /**
   * Offset into the ranked list, not a session id. Ids are not in a cursor at
   * all, so nothing here depends on `sessions.id` being unique over time —
   * though it is, because PR 2 made the column AUTOINCREMENT so a purged
   * session's id is never reissued to a live one.
   */
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

/**
 * The offset this cursor points at, or a typed rejection.
 *
 * Every rejection carries `actualGeneration`, and every one that could read a
 * generation out of the cursor carries `expectedGeneration` too, so a caller
 * can tell "the index moved under you, ask for page one" from "this cursor is
 * not ours" and act on the first without showing anyone an error.
 */
export function decodeSessionSearchCursor(cursor: string, generation: number, key: string): number {
  let payload: CursorPayload
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as CursorPayload
  } catch {
    throw new SessionSearchCursorError('malformed', generation)
  }
  // A generation that survived parsing is worth reporting even when the rest of
  // the payload is unusable: it is what tells the caller which snapshot the
  // cursor thought it was walking.
  // A counter, so a fraction or a negative is forged rather than stale.
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
  // Generation first: a caller who changed the query AND waited through a
  // publish should hear about the index moving, which is the condition it
  // cannot fix by paging again.
  if (claimed !== generation) {
    throw new SessionSearchCursorError('stale-generation', generation, claimed)
  }
  if (payload.k !== key) {
    throw new SessionSearchCursorError('different-query', generation, claimed)
  }
  return payload.o
}
