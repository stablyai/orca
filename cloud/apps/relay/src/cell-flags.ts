import { z } from 'zod'
import type { ControlFlagParse } from './relay-control-flag-channel.js'

// Every switch defaults to off. A newer writer may name flags this image lacks, so unknown
// keys are dropped; a known key with a bad value voids the object.
export type CellFlags = {
  readinessLocal: boolean
  ticketCheck: 'off' | 'shadow'
}

export const CELL_FLAG_DEFAULTS: CellFlags = { readinessLocal: false, ticketCheck: 'off' }

export const CELL_FLAGS_APPLIED_EVENT = 'orca_relay_cell_flags_applied'

const CellFlagsSchema = z.object({
  readinessLocal: z.boolean().default(CELL_FLAG_DEFAULTS.readinessLocal),
  ticketCheck: z.enum(['off', 'shadow']).default(CELL_FLAG_DEFAULTS.ticketCheck)
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
