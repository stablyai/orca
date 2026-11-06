import { z } from 'zod'
import { openEnum, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

const GIT_BRANCH_CHANGE_STATUS = ['modified', 'added', 'deleted', 'renamed', 'copied'] as const
const GIT_BRANCH_COMPARE_STATUS = [
  'ready',
  'invalid-base',
  'unborn-head',
  'no-merge-base',
  'loading',
  'error'
] as const

// Commit history requires only path; counts are guarded and status is unread.
const gitChangedFileSchema = z.looseObject({
  path: z.string(),
  status: openEnum(GIT_BRANCH_CHANGE_STATUS, 'modified').optional(),
  oldPath: z.string().optional(),
  added: z.number().optional(),
  removed: z.number().optional()
})

// Branch rows additionally read status unguarded for labels and colors.
const gitBranchChangeEntrySchema = gitChangedFileSchema.extend({
  status: openEnum(GIT_BRANCH_CHANGE_STATUS, 'modified')
})

// Summary fields are read unguarded; nullable headOid/mergeBase gate opening a diff.
const gitBranchCompareSummarySchema = z.looseObject({
  baseRef: z.string(),
  changedFiles: z.number(),
  status: openEnum(GIT_BRANCH_COMPARE_STATUS, 'error'),
  baseOid: z.string().nullable().optional(),
  compareRef: z.string().optional(),
  headOid: z.string().nullable().optional(),
  mergeBase: z.string().nullable().optional(),
  commitsAhead: salvagedOptional('commitsAhead', z.number()),
  errorMessage: salvagedOptional('errorMessage', z.string())
})

// Summary is read unguarded; nullish entries must still reach the consumer’s empty-list fallback.
export const gitBranchCompareResultSchema = z.looseObject({
  summary: gitBranchCompareSummarySchema,
  entries: salvagingArray(gitBranchChangeEntrySchema).nullish()
})

// The diff screen diffs a commit's files against this parent; null is a root commit.
export const gitCommitCompareResultSchema = z.looseObject({
  summary: salvagedOptional(
    'summary',
    z.looseObject({
      parentOid: z.string().nullable().optional(),
      status: z.string().optional(),
      errorMessage: z.string().optional()
    })
  ),
  entries: salvagingArray(gitChangedFileSchema)
})

export type MobileGitChangedFile = z.output<typeof gitChangedFileSchema>
export type MobileGitBranchChangeEntry = z.output<typeof gitBranchChangeEntrySchema>
export type MobileGitBranchCompareSummary = z.output<typeof gitBranchCompareSummarySchema>
export type MobileGitBranchCompareReply = z.output<typeof gitBranchCompareResultSchema>
