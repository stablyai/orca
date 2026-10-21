import { z } from 'zod'
import { openEnum, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The three compare replies the Changes screen and the history list read: `git.branchCompare`,
// `git.commitCompare` and `git.branchDiff`. Checked against GitBranchCompareResult,
// GitCommitCompareResult and GitDiffResult in src/shared/git-diff-compare-types.ts, which
// src/main/runtime/rpc/methods/git.ts returns from the runtime compare calls verbatim.

const GIT_BRANCH_CHANGE_STATUS = ['modified', 'added', 'deleted', 'renamed', 'copied'] as const
const GIT_BRANCH_COMPARE_STATUS = [
  'ready',
  'invalid-base',
  'unborn-head',
  'no-merge-base',
  'loading',
  'error'
] as const

/**
 * One changed file as the commit list reads it: `path` only.
 *
 * MobileGitHistoryList.tsx:171 keys the row by `path` and :176-177 renders `added`/`removed`
 * behind a truthy check. It never reads `status`, so this list does not require it — the two
 * compare replies share a host type but not a set of readers.
 */
const gitChangedFileSchema = z.looseObject({
  path: z.string(),
  status: openEnum(GIT_BRANCH_CHANGE_STATUS, 'modified').optional(),
  oldPath: z.string().optional(),
  added: z.number().optional(),
  removed: z.number().optional()
})

/**
 * The same file as the branch list reads it, which additionally colours and labels the row by
 * `status` with no guard (MobileSourceControlFileRows.tsx:219-220) and sorts on `path`
 * (mobile-branch-compare.ts:27).
 */
const gitBranchChangeEntrySchema = gitChangedFileSchema.extend({
  status: openEnum(GIT_BRANCH_CHANGE_STATUS, 'modified')
})

/**
 * The compare summary. `baseRef`, `changedFiles` and `status` are required: formatMobileBranch-
 * CompareSummary reads all three unguarded (mobile-branch-compare.ts:38-45), and
 * use-mobile-source-control-state.ts:149 reads `summary.status` again. `headOid` and `mergeBase`
 * gate the branch-diff open (:50) and are nullable in the host type, so both stay nullable here.
 */
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

/**
 * `summary` is required: use-mobile-source-control-state.ts:131/134/149 and
 * MobileSourceControlFileRows.tsx:190 reach it with only the result null-checked. `entries` is
 * nullish because :127 reads `branchCompareResult?.entries ?? []` — a reply without a list is an
 * empty section today, and making it fatal would turn that into a full-screen error. Nullish, not
 * optional, so a host that sends an explicit `null` reaches that same `?? []` rather than failing
 * the whole compare, the way `timestamp` does in git-history-reply-schema.ts.
 */
export const gitBranchCompareResultSchema = z.looseObject({
  summary: gitBranchCompareSummarySchema,
  entries: salvagingArray(gitBranchChangeEntrySchema).nullish()
})

/** The commit-compare list. Only `entries` has a reader: MobileGitHistoryList.tsx:114-115. */
export const gitCommitCompareResultSchema = z.looseObject({
  entries: salvagingArray(gitChangedFileSchema)
})

/**
 * A single file's diff.
 *
 * Two declared shapes rather than one: mobile renders only `kind: 'text'` and throws its own copy
 * on anything else (use-mobile-source-control-openers.ts:264-267). So the text shape requires the
 * two contents it renders, and every other kind needs nothing but a `kind` to route on — including
 * a kind a newer host adds, which must reach that same throw rather than an incompatible reply.
 */
const gitDiffTextSchema = z.looseObject({
  kind: z.literal('text'),
  originalContent: z.string(),
  modifiedContent: z.string()
})

// Renamed to one discriminant so the consumer's `kind !== 'text'` still narrows. The host's own
// kind is dropped rather than carried: nothing reads it.
const gitDiffOtherKindSchema = z
  .object({ kind: z.string() })
  .transform(() => ({ kind: 'not-text' as const }))

export const gitDiffResultSchema = z.union([gitDiffTextSchema, gitDiffOtherKindSchema])

export type MobileGitChangedFile = z.output<typeof gitChangedFileSchema>
export type MobileGitBranchChangeEntry = z.output<typeof gitBranchChangeEntrySchema>
export type MobileGitBranchCompareSummary = z.output<typeof gitBranchCompareSummarySchema>
export type MobileGitBranchCompareReply = z.output<typeof gitBranchCompareResultSchema>
export type MobileGitDiffReply = z.output<typeof gitDiffResultSchema>
