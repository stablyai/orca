import type { z } from 'zod'
import type { JournalReducerState } from './journal-reducer'
import { outcomeFormat1Fields } from './journal-outcome-format-1'

// Every reducer key needs an explicit stored representation in the format this build writes.
export const fields = outcomeFormat1Fields satisfies Record<keyof JournalReducerState, z.ZodType>
