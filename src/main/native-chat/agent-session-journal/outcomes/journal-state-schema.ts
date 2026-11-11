import { z } from 'zod'
import type { JournalReducerState } from '../projection/journal-reducer'
import { outcomeFormat1Fields } from './journal-outcome-format-1'
import { outcomeFormat3PauseMarks } from './journal-outcome-format-3'
import { inputEntrySchema, inputCardSchema } from './journal-outcome-format-2'

// Every reducer key needs an explicit stored representation in the format this build writes.
export const fields = {
  ...outcomeFormat1Fields,
  queuePauseMarks: outcomeFormat3PauseMarks,
  inputEntries: z.array(z.tuple([z.string().min(1), inputEntrySchema])),
  inputCards: z.array(z.tuple([z.string().min(1), inputCardSchema]))
} satisfies Record<Exclude<keyof JournalReducerState, 'inputs'>, z.ZodType>
