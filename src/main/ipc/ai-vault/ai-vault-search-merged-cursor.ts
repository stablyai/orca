import { z } from 'zod'

/** Refetch host cursor c, skip e emitted hits within generation g; null c starts that host's walk. */
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

/** Reject malformed cursor shapes. */
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
