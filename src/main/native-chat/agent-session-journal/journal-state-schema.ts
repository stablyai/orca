import { z } from 'zod'
import type { JournalReducerState } from './journal-reducer'
import { outcomeFormat1Fields } from './journal-outcome-format-1'
import { inputEntrySchema, inputCardSchema } from './journal-outcome-format-2'

// Every reducer key needs an explicit stored representation in the format this build writes.
export const fields = {
  ...outcomeFormat1Fields,
  inputEntries: z.array(z.tuple([z.string().min(1), inputEntrySchema])),
  inputCards: z.array(z.tuple([z.string().min(1), inputCardSchema]))
} satisfies Record<keyof JournalReducerState, z.ZodType>
