import type { z } from 'zod'
import type { JournalReducerState } from './journal-reducer'
import { outcomeFormat1Fields, outcomeFormat1Scalars } from './journal-outcome-format-1'

// Cache codec 3 stores outcome format 1's values; a cache layout change forks its schemas here, never
// in the frozen format. Every reducer key needs an explicit stored representation.
export const fields = outcomeFormat1Fields satisfies Record<keyof JournalReducerState, z.ZodType>
export const scalarsV2 = outcomeFormat1Scalars
