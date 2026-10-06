import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type {
  MobileGitBranchCompareResult,
  MobileGitBranchCompareSummary
} from '../source-control/mobile-branch-compare'

// The replies the diff-review screen and the PR branch-context loader read: `git.branchCompare`
// normalized, `worktree.show`'s review notes, `git.diff` / `git.branchDiff`, and the three
// file-level git mutations. Checked against GitBranchCompareResult and GitDiffResult in
// src/shared/git-diff-compare-types.ts and the worktree record in src/shared/runtime-types.ts,
// all of which src/main/runtime/rpc/methods/git.ts and worktree.ts return verbatim.
//
// These are projections, not the verbatim payloads the Changes screen publishes. Where main's
// hand parser dropped a member, so does this schema; where it answered a value the consumer
// immediately turned into its own error, the schema refuses instead, so the error names the method.

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

// Built once: readProjectedCompareStatus runs on every reply.
const gitBranchCompareStatusSchema = z.enum(GIT_BRANCH_COMPARE_STATUS)

/**
 * One committed change.
 *
 * `status` is a closed set on purpose, where the Changes screen's verbatim reader opens it: main
 * dropped a row whose status it did not recognise — `untracked` included, which cannot be a
 * committed change — so degrading an unknown arm to `modified` here would add a row main never
 * drew. `path` is non-empty because main's `!path` drop is falsy, not nullish.
 */
const branchChangeEntrySchema = z.looseObject({
  path: z.string().min(1),
  status: z.enum(GIT_BRANCH_CHANGE_STATUS),
  oldPath: salvagedOptional('oldPath', z.string()),
  added: salvagedOptional('added', z.number().finite()),
  removed: salvagedOptional('removed', z.number().finite())
})

/**
 * The compare summary the review screen and the PR branch context share.
 *
 * `baseRef`, `compareRef` and `changedFiles` are required and answer for the whole reply: main
 * returned null when any was missing, and three screens route on that null. `status` is the one
 * member main coerced rather than dropped — an unreadable or absent status became `error`, which
 * formatMobileBranchCompareSummary renders — so it is read as unknown and coerced in the
 * transform rather than declared as an enum, whose absence would be fatal.
 */
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

/**
 * The normalized compare both review loaders read.
 *
 * `entries` is a required array because main answered null without one, and a salvaging array so a
 * single unreadable row drops instead of failing the compare. No `.catch(null)`: every caller
 * turned main's null into an error string of its own ("Committed changes response was invalid"),
 * so refusing here names the method in that same slot instead of inventing a second vocabulary.
 */
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

// Main coerced an unreadable compare status to 'error' rather than dropping the reply, and the
// summary line renders off that value, so the coercion is the behaviour rather than a defect.
function readProjectedCompareStatus(value: unknown): GitBranchCompareStatus {
  const parsed = gitBranchCompareStatusSchema.safeParse(value)
  return parsed.success ? parsed.data : 'error'
}

export type MobileReviewWorktreeMetadata = {
  diffComments: unknown
  mobileDiffReview: unknown
}

/**
 * The two review members the screen keeps off the worktree record.
 *
 * Neither is required: both are normalized downstream (mobile-diff-review-loaders.ts:119-120 hands
 * them to normalizeMobileDiffComments and normalizeMobileDiffReviewState, which accept anything),
 * and a worktree that has never been reviewed carries neither. `worktree` is salvaged rather than
 * required for the same reason main tolerated it: a record it could not read became two absent
 * members, not an error.
 */
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

/**
 * A single file's diff, as the review screen renders it.
 *
 * Three arms and nothing else, because the screen has a render for each and no fallback: main
 * answered null for any other shape and mobile-diff-review-loaders.ts:175 turned that null into
 * "Diff response was invalid" on the spot. Refusing instead puts the method in that message. The
 * arm set is closed for the same reason the entry status is: a kind this build cannot render is
 * not a diff it can degrade into one.
 */
export const reviewGitDiffSchema = z.union([
  reviewTextDiffSchema,
  reviewBinaryDiffSchema,
  reviewTooLargeDiffSchema
])

/**
 * The three file-level git mutations and the bulk stage.
 *
 * Nothing is declared: use-mobile-diff-review-git-actions.ts:42 discards the interpretation and
 * :80 reads only the acceptance verdict, so every member here would be a requirement with no
 * reader behind it.
 */
export const reviewGitMutationSchema = z.unknown()

export type MobileReviewGitDiffResult = z.output<typeof reviewGitDiffSchema>
