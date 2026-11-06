import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Require only consumed fields so older hosts can omit unread history metadata.

const gitHistoryStatisticsSchema = z.looseObject({
  files: z.number(),
  insertions: z.number(),
  deletions: z.number()
})

// id and parentIds are read unguarded; the remaining displayed fields have consumer fallbacks.
const gitHistoryItemSchema = z.looseObject({
  id: z.string(),
  parentIds: z.array(z.string()),
  subject: z.string().optional(),
  message: salvagedOptional('message', z.string()),
  displayId: z.string().optional(),
  author: z.string().optional(),
  // Hosts send null for undated commits; number-or-absent would drop valid rows.
  timestamp: z.number().nullish(),
  statistics: salvagedOptional('statistics', gitHistoryStatisticsSchema),
  // Branch-only pages only; absent means unknown, not unpushed.
  pushed: salvagedOptional('pushed', z.boolean())
})

const gitHistoryBranchRangeSchema = z.looseObject({
  // Only a remote base can be rebased onto, so Update branch reads the category too.
  baseRef: z.looseObject({ name: z.string(), category: z.string().optional() }),
  ahead: z.number(),
  behind: z.number(),
  unpushed: z.number()
})

// items is read unguarded; salvage individual malformed rows instead of discarding the whole history.
export const gitHistoryResultSchema = z.looseObject({
  items: salvagingArray(gitHistoryItemSchema),
  hasMore: salvagedOptional('hasMore', z.boolean()),
  // Older hosts ignore branchOnly and skip, so these echoes are how a client knows they applied.
  branch: salvagedOptional('branch', gitHistoryBranchRangeSchema),
  skip: salvagedOptional('skip', z.number())
})

export type MobileGitHistoryResult = z.output<typeof gitHistoryResultSchema>
export type MobileGitHistoryItem = z.output<typeof gitHistoryItemSchema>
export type MobileGitHistoryBranchRange = z.output<typeof gitHistoryBranchRangeSchema>
