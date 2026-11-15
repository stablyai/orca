import { z } from 'zod'
import { SessionSearchCursorError } from './session-search-page-cursor'

export const SESSION_SEARCH_MAX_CANDIDATES = 600
const PREFIX = 'ss2.'
const MAX_CURSOR_CHARS = 256 * 1024
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const tokens = z.array(z.string().max(512)).max(64)
const rankedCursorSchema = z.object({
  v: z.literal(2),
  i: z.string().min(1).max(128),
  g: integer,
  r: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  k: z.string().max(128),
  o: integer,
  hits: z
    .array(
      z.object({
        s: integer.positive(),
        m: integer.positive().nullable(),
        score: z.number().finite(),
        d: integer.positive().max(SESSION_SEARCH_MAX_CANDIDATES)
      })
    )
    .max(SESSION_SEARCH_MAX_CANDIDATES),
  retrieval: z
    .object({
      route: z.enum(['phrase', 'and', 'or', 'typo+phrase', 'typo+and', 'typo+or']),
      plan: z.object({
        literal: z.boolean(),
        truncated: z.boolean(),
        terms: tokens,
        body: tokens,
        phrase: tokens
      }),
      repairedTerms: tokens.optional()
    })
    .nullable(),
  incomplete: z.boolean(),
  queryTruncated: z.boolean()
})

export type SessionSearchRankedCursor = z.infer<typeof rankedCursorSchema>
export type SessionSearchFrozenHit = SessionSearchRankedCursor['hits'][number]

export function encodeRankedSessionSearchCursor(cursor: SessionSearchRankedCursor): string {
  return `${PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`
}

/** Legacy cursors retain raw-generation fencing and offset interpretation. */
export function decodeRankedSessionSearchCursor(
  raw: string,
  generation: number,
  revision: number,
  key: string,
  incarnation: string
): SessionSearchRankedCursor | null {
  if (!raw.startsWith(PREFIX)) {
    return null
  }
  let parsed: unknown
  try {
    if (raw.length > MAX_CURSOR_CHARS) {
      throw new Error('Cursor too large')
    }
    parsed = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    throw new SessionSearchCursorError('malformed', generation)
  }
  const result = rankedCursorSchema.safeParse(parsed)
  if (!result.success) {
    throw new SessionSearchCursorError('malformed', generation)
  }
  const cursor = result.data
  if (
    cursor.o >= cursor.hits.length ||
    new Set(cursor.hits.map((hit) => hit.s)).size !== cursor.hits.length
  ) {
    throw new SessionSearchCursorError('malformed', generation, cursor.g)
  }
  if (cursor.r !== revision || cursor.i !== incarnation) {
    throw new SessionSearchCursorError('stale-generation', generation, cursor.g)
  }
  if (cursor.k !== key) {
    throw new SessionSearchCursorError('different-query', generation, cursor.g)
  }
  return cursor
}
