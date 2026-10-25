import { z } from 'zod'
import { salvagingArray } from '../../../src/shared/zod-salvage'

// Require only consumed fields so older hosts can omit unread history metadata.

// id and parentIds are read unguarded; the remaining displayed fields have consumer fallbacks.
const gitHistoryItemSchema = z.looseObject({
  id: z.string(),
  parentIds: z.array(z.string()),
  subject: z.string().optional(),
  displayId: z.string().optional(),
  author: z.string().optional(),
  // Hosts send null for undated commits; number-or-absent would drop valid rows.
  timestamp: z.number().nullish()
})

// items is read unguarded; salvage individual malformed rows instead of discarding the whole history.
export const gitHistoryResultSchema = z.looseObject({
  items: salvagingArray(gitHistoryItemSchema)
})

export type MobileGitHistoryResult = z.output<typeof gitHistoryResultSchema>
export type MobileGitHistoryItem = z.output<typeof gitHistoryItemSchema>
