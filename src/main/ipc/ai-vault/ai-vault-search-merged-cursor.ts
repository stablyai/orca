import {
  AiVaultSearchHitSchema,
  AiVaultSearchTruncationSchema
} from '../../../shared/ai-vault/search/ai-vault-search-contract'
import { SESSION_SEARCH_LIMIT_MAX } from '../../../shared/ai-vault/search/ai-vault-search-limit'
import type { AiVaultSearchHit } from '../../../shared/ai-vault/search/ai-vault-search-types'
import { z } from 'zod'

/** Legacy entries refetch c and skip e; carried entries replay p, then read c without an offset. */
export type MergedSearchCursorEntry = {
  c: string | null
  e: number
  g: number
  p?: AiVaultSearchHit[]
  t?: z.infer<typeof AiVaultSearchTruncationSchema>
}

export type MergedSearchCursor = {
  /** Page size and sort the cursor was minted for; a cursor belongs to one query. */
  limit: number
  sort: 'relevance' | 'newest'
  key?: string
  hosts: Record<string, MergedSearchCursorEntry>
}

const mergedCursorPayloadSchema = z.object({
  v: z.literal(2).optional(),
  k: z.string().max(128).optional(),
  l: z.number().int().positive(),
  s: z.enum(['relevance', 'newest']),
  h: z.record(
    z.string().min(1),
    z.object({
      c: z.string().nullable(),
      e: z.number().int().nonnegative(),
      g: z.number().int().nonnegative(),
      p: z.array(AiVaultSearchHitSchema).max(SESSION_SEARCH_LIMIT_MAX).optional(),
      t: AiVaultSearchTruncationSchema.optional()
    })
  )
})

export function encodeMergedSearchCursor(cursor: MergedSearchCursor): string {
  const payload = { v: 2, k: cursor.key, l: cursor.limit, s: cursor.sort, h: cursor.hosts }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Reject malformed cursor shapes. */
export function decodeMergedSearchCursor(raw: string): MergedSearchCursor | null {
  if (raw.length > 16 * 1024 * 1024) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const result = mergedCursorPayloadSchema.safeParse(parsed)
  if (
    !result.success ||
    (result.data.v === 2 && !result.data.k) ||
    (result.success &&
      result.data.v !== 2 &&
      Object.values(result.data.h).some((entry) => entry.p !== undefined))
  ) {
    return null
  }
  return { key: result.data.k, limit: result.data.l, sort: result.data.s, hosts: result.data.h }
}
