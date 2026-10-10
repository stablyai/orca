import { z } from 'zod'
import type { ControlFlagParse } from './relay-control-flag-channel.js'

// Every switch defaults to off. A newer writer may name flags this image lacks, so unknown
// keys are dropped; a known key with a bad value voids the object.
export type CellFlags = {
  readinessLocal: boolean
  // `enforce` admits a hello on a valid lease alone; only reserve mode reads it.
  ticketCheck: 'off' | 'shadow' | 'enforce'
  // Off restores Node's default: any unhandled rejection ends the process (#26817 reverted).
  rejectionFence: boolean
  // Past statement_timeout before a lost reply ends its connection; absent keeps the boot value.
  readTimeoutMarginMs?: number
  // Step 5: `reserve` admits booked and recently seated hosts without the database.
  admitMode: 'db' | 'reserve'
  // Bookings per second this cell accepts; absent means its region's default.
  intakePerSec?: number
  // Answers a director's dry-run booking check; off, the reserve endpoint is inert in db mode.
  reserveDryRun: boolean
  // Flip-back leases in flight at once; absent is a third of the pool. Speeds up one cell.
  reregisterInFlight?: number
}

export const CELL_FLAG_DEFAULTS: CellFlags = {
  readinessLocal: false,
  ticketCheck: 'off',
  rejectionFence: true,
  admitMode: 'db',
  reserveDryRun: false
}

export const READ_TIMEOUT_MARGIN_MIN_MS = 1_000
export const READ_TIMEOUT_MARGIN_MAX_MS = 60_000

// Until E-pre measures each cell's accept rate (S3 §4.2).
export function defaultIntakePerSec(region: string | undefined): number {
  return region === 'asia-east2' ? 2 : 5
}

export const CELL_FLAGS_APPLIED_EVENT = 'orca_relay_cell_flags_applied'

const CellFlagsSchema = z.object({
  readinessLocal: z.boolean().default(CELL_FLAG_DEFAULTS.readinessLocal),
  ticketCheck: z.enum(['off', 'shadow', 'enforce']).default(CELL_FLAG_DEFAULTS.ticketCheck),
  rejectionFence: z.boolean().default(CELL_FLAG_DEFAULTS.rejectionFence),
  readTimeoutMarginMs: z
    .number()
    .int()
    .min(READ_TIMEOUT_MARGIN_MIN_MS)
    .max(READ_TIMEOUT_MARGIN_MAX_MS)
    .optional(),
  admitMode: z.enum(['db', 'reserve']).default(CELL_FLAG_DEFAULTS.admitMode),
  intakePerSec: z.number().positive().max(1_000).optional(),
  reserveDryRun: z.boolean().default(CELL_FLAG_DEFAULTS.reserveDryRun),
  reregisterInFlight: z.number().int().min(1).max(16).optional()
})
const KNOWN_FLAG_KEYS = new Set(Object.keys(CellFlagsSchema.shape))

export type SupportedCellFlag =
  | { type: 'boolean' }
  | { type: 'enum'; values: string[] }
  | { type: 'number'; min?: number; max?: number; integer?: boolean }

// Parsed, never offered: ticketCheck=enforce has no step that turns it on yet.
const UNOFFERED_FLAG_VALUES: Record<string, string[]> = { ticketCheck: ['enforce'] }

// What this image accepts, read from the schema itself: the flag tool refuses a key or value
// the cell would drop or void before it writes.
export function supportedCellFlags(): Record<string, SupportedCellFlag> {
  const supported: Record<string, SupportedCellFlag> = {}
  for (const [key, field] of Object.entries(CellFlagsSchema.shape)) {
    let inner: z.ZodTypeAny = field
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional) {
      inner = inner instanceof z.ZodDefault ? inner.removeDefault() : inner.unwrap()
    }
    if (inner instanceof z.ZodBoolean) supported[key] = { type: 'boolean' }
    else if (inner instanceof z.ZodEnum) {
      const unoffered = UNOFFERED_FLAG_VALUES[key] ?? []
      supported[key] = { type: 'enum', values: inner.options.filter((value: string) => !unoffered.includes(value)) }
    }
    else if (inner instanceof z.ZodNumber) {
      supported[key] = {
        type: 'number',
        ...(inner.minValue === null ? {} : { min: inner.minValue }),
        ...(inner.maxValue === null ? {} : { max: inner.maxValue }),
        ...(inner.isInt ? { integer: true } : {})
      }
    }
  }
  return supported
}

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
