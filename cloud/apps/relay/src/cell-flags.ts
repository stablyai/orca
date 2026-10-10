import { z } from 'zod'
import type { ControlFlagParse } from './relay-control-flag-channel.js'

// Every switch defaults to off. A newer writer may name flags this image lacks, so unknown
// keys are dropped; a known key with a bad value voids the object.
export type CellFlags = {
  readinessLocal: boolean
  // `enforce` admits a hello on a valid lease alone; only reserve mode reads it.
  ticketCheck: 'off' | 'shadow' | 'enforce'
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
  admitMode: 'db',
  reserveDryRun: false
}

// Until E-pre measures each cell's accept rate (S3 §4.2).
export function defaultIntakePerSec(region: string | undefined): number {
  return region === 'asia-east2' ? 2 : 5
}

export const CELL_FLAGS_APPLIED_EVENT = 'orca_relay_cell_flags_applied'

const CellFlagsSchema = z.object({
  readinessLocal: z.boolean().default(CELL_FLAG_DEFAULTS.readinessLocal),
  ticketCheck: z.enum(['off', 'shadow', 'enforce']).default(CELL_FLAG_DEFAULTS.ticketCheck),
  admitMode: z.enum(['db', 'reserve']).default(CELL_FLAG_DEFAULTS.admitMode),
  intakePerSec: z.number().positive().max(1_000).optional(),
  reserveDryRun: z.boolean().default(CELL_FLAG_DEFAULTS.reserveDryRun),
  reregisterInFlight: z.number().int().min(1).max(16).optional()
})

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
    return parsed.success ? parsed.data.flags : null
  }
}
