import { z } from 'zod'

export type BinderSessionRow = {
  id: string
  directory: string
  createdAtMs: number
  parentId: string | null
}

/** Include ID so a page boundary cannot skip rows sharing a millisecond. */
export type OpenCodeSessionCursor = {
  ms: number
  id: string
}

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

// Validate structured-clone replies at the worker boundary.
export function parseOpenCodeBinderSessions(value: unknown): BinderSessionRow[] | null {
  const parsed = rowsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
