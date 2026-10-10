import { z } from 'zod'
import type { ControlFlagParse } from './relay-control-flag-channel.js'

// Every switch defaults to off. A newer writer may name flags this image lacks, so unknown
// keys are dropped; a known key with a bad value voids the object.
export type CellFlags = {
  readinessLocal: boolean
  ticketCheck: 'off' | 'shadow'
  // Off restores Node's default: any unhandled rejection ends the process (#26817 reverted).
  rejectionFence: boolean
  // Past statement_timeout before a lost reply ends its connection; absent keeps the boot value.
  readTimeoutMarginMs?: number
}

export const CELL_FLAG_DEFAULTS: CellFlags = {
  readinessLocal: false,
  ticketCheck: 'off',
  rejectionFence: true
}

export const READ_TIMEOUT_MARGIN_MIN_MS = 1_000
export const READ_TIMEOUT_MARGIN_MAX_MS = 60_000

export const CELL_FLAGS_APPLIED_EVENT = 'orca_relay_cell_flags_applied'

const CellFlagsSchema = z.object({
  readinessLocal: z.boolean().default(CELL_FLAG_DEFAULTS.readinessLocal),
  ticketCheck: z.enum(['off', 'shadow']).default(CELL_FLAG_DEFAULTS.ticketCheck),
  rejectionFence: z.boolean().default(CELL_FLAG_DEFAULTS.rejectionFence),
  readTimeoutMarginMs: z
    .number()
    .int()
    .min(READ_TIMEOUT_MARGIN_MIN_MS)
    .max(READ_TIMEOUT_MARGIN_MAX_MS)
    .optional()
})
const KNOWN_FLAG_KEYS = new Set(Object.keys(CellFlagsSchema.shape))

export function cellFlagObjectName(cellId: string): string {
  return `cells/${cellId}.json`
}

export function cellFlagParser(cellId: string): ControlFlagParse<CellFlags> {
  const ObjectSchema = z.object({
    v: z.literal(1),
    cellId: z.literal(cellId),
    flags: CellFlagsSchema
  })
  return (body) => {
    const parsed = ObjectSchema.safeParse(body)
    if (!parsed.success) return null
    const named = body !== null && typeof body === 'object' && 'flags' in body ? body.flags : {}
    const ignoredKeys =
      named !== null && typeof named === 'object'
        ? Object.keys(named).filter((key) => !KNOWN_FLAG_KEYS.has(key)).sort()
        : []
    return { flags: parsed.data.flags, ignoredKeys }
  }
}
