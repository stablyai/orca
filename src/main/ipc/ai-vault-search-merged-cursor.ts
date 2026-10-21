import { z } from 'zod'

/**
 * One host's place in a merged walk. `c` is the host cursor that produced the
 * page being consumed (null for that host's first page), `e` is how many of that
 * page's hits the merge already emitted, and `g` is the host generation `e`
 * counts into. Refetch with `c`, skip `e`, and no hit is skipped or repeated.
 */
export type MergedSearchCursorEntry = {
  c: string | null
  e: number
  g: number
}

export type MergedSearchCursor = {
  /** Page size and sort the cursor was minted for; a cursor belongs to one query. */
  limit: number
  sort: 'relevance' | 'newest'
  hosts: Record<string, MergedSearchCursorEntry>
}

const mergedCursorPayloadSchema = z.object({
  l: z.number().int().positive(),
  s: z.enum(['relevance', 'newest']),
  h: z.record(
    z.string().min(1),
    z.object({
      c: z.string().nullable(),
      e: z.number().int().nonnegative(),
      g: z.number().int().nonnegative()
    })
  )
})

export function encodeMergedSearchCursor(cursor: MergedSearchCursor): string {
  const payload = { l: cursor.limit, s: cursor.sort, h: cursor.hosts }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Null for anything that is not a cursor this module minted. */
export function decodeMergedSearchCursor(raw: string): MergedSearchCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const result = mergedCursorPayloadSchema.safeParse(parsed)
  if (!result.success) {
    return null
  }
  return { limit: result.data.l, sort: result.data.s, hosts: result.data.h }
}
