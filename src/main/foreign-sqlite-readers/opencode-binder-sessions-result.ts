import { z } from 'zod'

/** One session store row feeding a binder round. */
export type BinderSessionRow = {
  id: string
  directory: string
  createdAtMs: number
  parentId: string | null
}

/** Position in the session store; composite so same-millisecond rows are never skipped. */
export type OpenCodeSessionCursor = {
  ms: number
  id: string
}

/** No sessions: what the binder read has always answered when the store can't be read. */
export function openCodeBinderSessionsFailure(): BinderSessionRow[] {
  return []
}

const rowsSchema = z.array(
  z.object({
    id: z.string(),
    directory: z.string(),
    createdAtMs: z.number(),
    parentId: z.string().nullable()
  })
)

/** A worker reply arrives as a structured clone; null when it is not a list of session rows. */
export function parseOpenCodeBinderSessions(value: unknown): BinderSessionRow[] | null {
  const parsed = rowsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
