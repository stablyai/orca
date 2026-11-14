import { z } from 'zod'
import type { SqliteRow } from '../sqlite/sqlite-statement'

export type HermesSessionsQuery = { dbPath: string } & (
  | { operation: 'ids' }
  | { operation: 'list'; limit: number; scopePaths?: readonly string[] }
  | { operation: 'session'; sessionId: string }
)

const sessionRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  created_at: z.unknown(),
  updated_at: z.unknown()
})

type SessionRow = z.infer<typeof sessionRowSchema>

const resultSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('ids'), ids: z.array(z.string()) }),
  z.object({
    operation: z.literal('list'),
    files: z.array(z.object({ path: z.string(), mtimeMs: z.number(), modifiedAt: z.string() }))
  }),
  z.object({
    operation: z.literal('session'),
    session: z
      .object({
        row: sessionRowSchema,
        mtimeMs: z.number(),
        messages: z.array(z.object({ role: z.unknown(), content: z.unknown() }))
      })
      .nullable()
  })
])

export type HermesSessionsResult = z.infer<typeof resultSchema>

export function parseHermesSessionsResult(value: unknown): HermesSessionsResult | null {
  const parsed = resultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Normalizes an unknown timestamp value (seconds string or number) to milliseconds.
 */
export function timestampMs(val: unknown): number | null {
  let parsed = Number.NaN
  if (typeof val === 'number') {
    parsed = val < 1e11 ? val * 1000 : val
  } else if (typeof val === 'string') {
    const numeric = Number(val)
    if (val.trim() !== '' && Number.isFinite(numeric)) {
      parsed = numeric < 1e11 ? numeric * 1000 : numeric
    } else {
      parsed = Date.parse(val)
    }
  }
  return Number.isNaN(new Date(parsed).getTime()) ? null : parsed
}

export function readSessionRow(row: SqliteRow | undefined): SessionRow | null {
  if (!row || typeof row.id !== 'string') {
    return null
  }
  return {
    id: row.id,
    title: typeof row.title === 'string' ? row.title : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    model: typeof row.model === 'string' ? row.model : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function sessionMtimeMs(row: SessionRow, lastMessageAt: number | undefined): number {
  const sessionTime = timestampMs(row.updated_at) ?? timestampMs(row.created_at)
  return sessionTime === null
    ? (lastMessageAt ?? Date.now())
    : Math.max(sessionTime, lastMessageAt ?? sessionTime)
}
