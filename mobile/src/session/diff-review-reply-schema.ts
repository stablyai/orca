import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type {
  MobileGitBranchCompareResult,
  MobileGitBranchCompareSummary
} from '../source-control/mobile-branch-compare'

// These review projections normalize host payloads; the Changes screen’s readers preserve them verbatim.

const GIT_BRANCH_CHANGE_STATUS = ['modified', 'added', 'deleted', 'renamed', 'copied'] as const
const GIT_BRANCH_COMPARE_STATUS = [
  'ready',
  'invalid-base',
  'unborn-head',
  'no-merge-base',
  'loading',
  'error'
] as const

type GitBranchCompareStatus = (typeof GIT_BRANCH_COMPARE_STATUS)[number]

const gitBranchCompareStatusSchema = z.enum(GIT_BRANCH_COMPARE_STATUS)

// Keep committed statuses closed: unknown/untracked rows were never displayed here. Empty paths also drop.
const branchChangeEntrySchema = z.looseObject({
  path: z.string().min(1),
  status: z.enum(GIT_BRANCH_CHANGE_STATUS),
  oldPath: salvagedOptional('oldPath', z.string()),
  added: salvagedOptional('added', z.number().finite()),
  removed: salvagedOptional('removed', z.number().finite())
})

// Missing compare identity/count rejects the reply; unreadable status alone degrades to error for the summary.
const branchCompareSummarySchema = z.looseObject({
  baseRef: z.string().min(1),
  compareRef: z.string().min(1),
  changedFiles: z.number().finite(),
  status: z.unknown().optional(),
  baseOid: salvagedOptional('baseOid', z.string()),
  headOid: salvagedOptional('headOid', z.string()),
  mergeBase: salvagedOptional('mergeBase', z.string()),
  commitsAhead: salvagedOptional('commitsAhead', z.number().finite()),
  errorMessage: salvagedOptional('errorMessage', z.string())
})

// Require the entries container but salvage rows; reject unreadable compares so callers name the method instead of rendering partial data.
export const branchCompareProjectionSchema: z.ZodType<MobileGitBranchCompareResult, unknown> = z
  .looseObject({
    summary: branchCompareSummarySchema,
    entries: salvagingArray(branchChangeEntrySchema)
  })
  .transform((compare): MobileGitBranchCompareResult => ({
    summary: {
      baseRef: compare.summary.baseRef,
      baseOid: compare.summary.baseOid ?? null,
      compareRef: compare.summary.compareRef,
      headOid: compare.summary.headOid ?? null,
      mergeBase: compare.summary.mergeBase ?? null,
      changedFiles: compare.summary.changedFiles,
      commitsAhead: compare.summary.commitsAhead,
      status: readProjectedCompareStatus(compare.summary.status),
      errorMessage: compare.summary.errorMessage
    } satisfies MobileGitBranchCompareSummary,
    entries: compare.entries.map((entry) => ({
      path: entry.path,
      status: entry.status,
      oldPath: entry.oldPath,
      added: entry.added,
      removed: entry.removed
    }))
  }))

// Preserve the legacy error fallback because the summary renders from it.
function readProjectedCompareStatus(value: unknown): GitBranchCompareStatus {
  const parsed = gitBranchCompareStatusSchema.safeParse(value)
  return parsed.success ? parsed.data : 'error'
}

export type MobileReviewWorktreeMetadata = {
  diffComments: unknown
  mobileDiffReview: unknown
}

// Absent or unreadable worktree review fields normalize downstream; never-reviewed worktrees legitimately have neither.
export const reviewWorktreeMetadataSchema = z
  .looseObject({
    worktree: salvagedOptional(
      'worktree',
      z.looseObject({
        diffComments: z.unknown().optional(),
        mobileDiffReview: z.unknown().optional()
      })
    )
  })
  .transform((reply): MobileReviewWorktreeMetadata => ({
    diffComments: reply.worktree?.diffComments,
    mobileDiffReview: reply.worktree?.mobileDiffReview
  }))

const reviewTextDiffSchema = z
  .looseObject({
    kind: z.literal('text'),
    originalContent: z.string(),
    modifiedContent: z.string()
  })
  .transform((diff) => ({
    kind: 'text' as const,
    originalContent: diff.originalContent,
    modifiedContent: diff.modifiedContent
  }))

const reviewBinaryDiffSchema = z
  .looseObject({ kind: z.literal('binary') })
  .transform(() => ({ kind: 'binary' as const }))

const reviewTooLargeDiffSchema = z
  .looseObject({
    kind: z.literal('too-large'),
    byteLength: salvagedOptional('byteLength', z.number().finite())
  })
  .transform((diff) => ({ kind: 'too-large' as const, byteLength: diff.byteLength }))

// Keep text/binary/too-large closed because the screen has no renderer for an unknown arm.
export const reviewGitDiffSchema = z.union([
  reviewTextDiffSchema,
  reviewBinaryDiffSchema,
  reviewTooLargeDiffSchema
])

// Mutation callers read only acceptance; requiring unused payload fields would reject usable replies.
export const reviewGitMutationSchema = z.unknown()

export type MobileReviewGitDiffResult = z.output<typeof reviewGitDiffSchema>
