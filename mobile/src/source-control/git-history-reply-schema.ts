import { z } from 'zod'
import { openEnum, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

const GIT_HISTORY_REF_CATEGORIES = ['branches', 'remote branches', 'tags', 'commits'] as const

// Require only consumed fields so older hosts can omit unread history metadata.

const gitHistoryRefSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  revision: z.string().optional(),
  category: openEnum(GIT_HISTORY_REF_CATEGORIES, undefined).optional()
})

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
  authorEmail: salvagedOptional('authorEmail', z.string()),
  // Hosts send null for undated commits; number-or-absent would drop valid rows.
  timestamp: z.number().nullish(),
  statistics: salvagedOptional('statistics', gitHistoryStatisticsSchema),
  references: salvagedOptional('references', salvagingArray(gitHistoryRefSchema))
})

// items is read unguarded; salvage individual malformed rows instead of discarding the whole history.
export const gitHistoryResultSchema = z.looseObject({
  items: salvagingArray(gitHistoryItemSchema),
  currentRef: salvagedOptional('currentRef', gitHistoryRefSchema),
  remoteRef: salvagedOptional('remoteRef', gitHistoryRefSchema),
  baseRef: salvagedOptional('baseRef', gitHistoryRefSchema),
  mergeBase: salvagedOptional('mergeBase', z.string()),
  hasMore: salvagedOptional('hasMore', z.boolean()),
  limit: salvagedOptional('limit', z.number())
})

export type MobileGitHistoryResult = z.output<typeof gitHistoryResultSchema>
export type MobileGitHistoryItem = z.output<typeof gitHistoryItemSchema>
