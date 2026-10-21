import { z } from 'zod'

// Step 5 wire between directors and cells (v1). Directors book a seat on a cell before
// answering a desktop; the cell admits or refuses each booking itself. Readers ignore
// unknown fields, so either side may add optional ones.

export const CELL_RESERVE_PATH = '/internal/reserve'
export const CELL_DEMOTE_PATH = '/internal/demote'

export const CELL_RESERVE_MAX_ITEMS = 64
export const CELL_RESERVE_TTL_MS = 30_000
export const CELL_INTAKE_BURST = 20

export const ReserveItemSchema = z.object({
  userId: z.string().min(1).max(256),
  relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  epoch: z.number().int().positive(),
  ttlMs: z.number().int().positive().max(CELL_RESERVE_TTL_MS),
  // The re-booking of a host seated here before this cell restarted: no intake token.
  sticky: z.boolean().optional()
})
export type ReserveItem = z.infer<typeof ReserveItemSchema>

export const ReserveRequestSchema = z.object({
  v: z.literal(1),
  directorId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  // Checks every rule and books nothing (the shadow gate measures this before any flip).
  dryRun: z.boolean().optional(),
  items: z.array(ReserveItemSchema).min(1).max(CELL_RESERVE_MAX_ITEMS)
})
export type ReserveRequest = z.infer<typeof ReserveRequestSchema>

// `off`: the cell is not in reserve mode, so the director must use the database path.
export type ReserveOutcome =
  | { outcome: 'ok' }
  | { outcome: 'full' }
  | { outcome: 'intake' }
  | { outcome: 'draining' }
  | { outcome: 'off' }
  | { outcome: 'seated-newer'; epoch: number }

// Lenient: a newer cell may answer an outcome this director does not know; it counts as a no.
export const ReserveResponseSchema = z.object({
  v: z.literal(1),
  results: z.array(
    z.object({ outcome: z.string(), epoch: z.number().int().optional() }).passthrough()
  )
})

// Names one seat exactly: the epoch alone would also match the host rejoining this cell later.
export const DemoteRequestSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1).max(256),
  relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  epoch: z.number().int().positive(),
  joinedAt: z.number().int().nonnegative()
})
export type DemoteRequest = z.infer<typeof DemoteRequestSchema>
