import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type { PRInfo } from '../../../src/shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../src/shared/github/work-item-types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import {
  CHECK_STATUS,
  MERGEABLE_STATE,
  PR_STATE,
  REVIEW_DECISION,
  prCheckList,
  prCheckSummary,
  prCommentList,
  prCount,
  prFlag,
  prMergeMethodSettings,
  prNullableFlag,
  prNullableText,
  prRepoIdentity,
  prReviewList,
  prStringList,
  prText,
  prUserList
} from './github-pr-entity-reply-schema'

// Require entity identity and default the rest for unguarded renderers; malformed containers reject, while valid null still means no review.

const HOSTED_REVIEW_STATE = ['open', 'closed', 'merged', 'draft'] as const
const HOSTED_REVIEW_PROVIDER = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea',
  'unsupported'
] as const

// Require slug string fields but retain legacy acceptance of empty strings.
export const githubPrRepoSlugSchema = z
  .looseObject({ owner: z.string(), repo: z.string(), host: prText('host') })
  .transform((slug) => ({
    owner: slug.owner,
    repo: slug.repo,
    ...(slug.host ? { host: slug.host } : {})
  }))
  .nullable()

// Unknown hosted-review providers degrade to null; the create gate recognizes only this closed provider set.
export const hostedReviewForBranchSchema = z
  .looseObject({
    provider: salvagedOptional('provider', z.enum(HOSTED_REVIEW_PROVIDER)),
    number: prCount('number'),
    title: prText('title'),
    state: salvagedOptional('state', z.enum(HOSTED_REVIEW_STATE)),
    url: prText('url'),
    status: salvagedOptional('status', z.enum(CHECK_STATUS)),
    updatedAt: prText('updatedAt'),
    mergeable: salvagedOptional('mergeable', z.enum(MERGEABLE_STATE)),
    reviewDecision: salvagedOptional('reviewDecision', z.enum(REVIEW_DECISION).nullable()),
    autoMergeEnabled: prFlag('autoMergeEnabled'),
    autoMergeAllowed: prNullableFlag('autoMergeAllowed'),
    mergeStateStatus: prNullableText('mergeStateStatus'),
    headSha: prText('headSha')
  })
  .transform((review): HostedReviewInfo | null =>
    review.provider === undefined || review.number === undefined
      ? null
      : {
          provider: review.provider,
          number: review.number,
          title: review.title ?? '',
          state: review.state ?? 'open',
          url: review.url ?? '',
          status: review.status ?? 'pending',
          updatedAt: review.updatedAt ?? '',
          mergeable: review.mergeable ?? 'UNKNOWN',
          reviewDecision: review.reviewDecision,
          autoMergeEnabled: review.autoMergeEnabled,
          autoMergeAllowed: review.autoMergeAllowed,
          mergeStateStatus: review.mergeStateStatus,
          headSha: review.headSha
        }
  )
  .nullable()

// Preserve prRepo and merge settings because checks and merge choices depend on them.
const pullRequestSchema = z
  .looseObject({
    number: prCount('number'),
    state: salvagedOptional('state', z.enum(PR_STATE)),
    title: prText('title'),
    url: prText('url'),
    checksStatus: salvagedOptional('checksStatus', z.enum(CHECK_STATUS)),
    updatedAt: prText('updatedAt'),
    mergeable: salvagedOptional('mergeable', z.enum(MERGEABLE_STATE)),
    reviewDecision: salvagedOptional('reviewDecision', z.enum(REVIEW_DECISION).nullable()),
    autoMergeEnabled: prFlag('autoMergeEnabled'),
    autoMergeAllowed: prNullableFlag('autoMergeAllowed'),
    mergeQueueRequired: prNullableFlag('mergeQueueRequired'),
    mergeStateStatus: prNullableText('mergeStateStatus'),
    headSha: prText('headSha'),
    prRepo: prRepoIdentity('prRepo'),
    mergeMethodSettings: prMergeMethodSettings('mergeMethodSettings')
  })
  .transform((pr): PRInfo | null =>
    pr.number === undefined || pr.state === undefined
      ? null
      : {
          number: pr.number,
          title: pr.title ?? '',
          state: pr.state,
          url: pr.url ?? '',
          checksStatus: pr.checksStatus ?? 'pending',
          updatedAt: pr.updatedAt ?? '',
          mergeable: pr.mergeable ?? 'UNKNOWN',
          reviewDecision: pr.reviewDecision,
          autoMergeEnabled: pr.autoMergeEnabled,
          autoMergeAllowed: pr.autoMergeAllowed,
          mergeQueueRequired: pr.mergeQueueRequired,
          mergeStateStatus: pr.mergeStateStatus,
          headSha: pr.headSha,
          prRepo: pr.prRepo,
          mergeMethodSettings: pr.mergeMethodSettings
        }
  )

// Expose only fields actually sent/read; do not fabricate PRRefreshOutcome metadata.
export type GitHubPrForBranchOutcome =
  | { kind: 'upstream-error'; message: string }
  | { kind: 'found'; pr: PRInfo }

// Accept legacy bare PR/null and classified outcomes; preserve upstream-error text as an in-band host result.
export const githubPrForBranchSchema: z.ZodType<GitHubPrForBranchOutcome | null, unknown> = z.union(
  [
    z
      .looseObject({ kind: z.literal('upstream-error'), message: prText('message') })
      .transform((outcome) => ({
        kind: 'upstream-error' as const,
        message: outcome.message ?? ''
      })),
    z.looseObject({ kind: z.literal('no-pr') }).transform(() => null),
    z.looseObject({ kind: z.literal('found'), pr: pullRequestSchema }).transform((outcome, ctx) => {
      if (!outcome.pr) {
        ctx.addIssue({
          code: 'custom',
          message: 'found outcome has no readable pr',
          input: outcome
        })
        return z.NEVER
      }
      return { kind: 'found' as const, pr: outcome.pr }
    }),
    pullRequestSchema.transform((pr, ctx) => {
      if (!pr) {
        ctx.addIssue({ code: 'custom', message: 'pull request has no number or state', input: pr })
        return z.NEVER
      }
      return { kind: 'found' as const, pr }
    }),
    z.null().transform(() => null)
  ]
)

const workItemSchema = z
  .looseObject({
    id: prText('id'),
    number: prCount('number'),
    type: salvagedOptional('type', z.enum(['issue', 'pr'] as const)),
    state: salvagedOptional('state', z.enum(PR_STATE)),
    title: prText('title'),
    url: prText('url'),
    labels: prStringList('labels'),
    updatedAt: prText('updatedAt'),
    author: prText('author'),
    branchName: prText('branchName'),
    baseRefName: prText('baseRefName'),
    headSha: prText('headSha'),
    reviewDecision: salvagedOptional('reviewDecision', z.enum(REVIEW_DECISION).nullable()),
    reviewRequests: prUserList('reviewRequests'),
    latestReviews: prReviewList('latestReviews'),
    assignees: prUserList('assignees'),
    checksSummary: prCheckSummary('checksSummary'),
    mergeable: salvagedOptional('mergeable', z.enum(MERGEABLE_STATE)),
    autoMergeEnabled: prFlag('autoMergeEnabled'),
    mergeStateStatus: prNullableText('mergeStateStatus')
  })
  .transform((item): Omit<GitHubWorkItem, 'repoId'> | null =>
    item.id === undefined ||
    item.number === undefined ||
    item.type === undefined ||
    item.state === undefined
      ? null
      : {
          id: item.id,
          type: item.type,
          number: item.number,
          title: item.title ?? '',
          state: item.state,
          url: item.url ?? '',
          labels: item.labels ?? [],
          updatedAt: item.updatedAt ?? '',
          author: item.author ?? null,
          branchName: item.branchName,
          baseRefName: item.baseRefName,
          headSha: item.headSha,
          reviewDecision: item.reviewDecision,
          reviewRequests: item.reviewRequests ?? [],
          latestReviews: item.latestReviews,
          assignees: item.assignees ?? [],
          checksSummary: item.checksSummary,
          mergeable: item.mergeable,
          autoMergeEnabled: item.autoMergeEnabled,
          mergeStateStatus: item.mergeStateStatus
        }
  )

// Require item identity for the detail pane; missing companion lists render empty.
export const githubWorkItemDetailsSchema = z
  .looseObject({
    item: workItemSchema,
    body: prText('body'),
    comments: prCommentList('comments'),
    headSha: prText('headSha'),
    baseSha: prText('baseSha'),
    pullRequestId: prText('pullRequestId'),
    checks: prCheckList('checks'),
    participants: prUserList('participants'),
    // Absent assignees means unreported, distinct from a confirmed empty list.
    assignees: salvagedOptional('assignees', salvagingArray(z.string()))
  })
  .transform((details): GitHubWorkItemDetails | null =>
    details.item === null
      ? null
      : {
          item: details.item,
          body: details.body ?? '',
          comments: details.comments ?? [],
          headSha: details.headSha,
          baseSha: details.baseSha,
          pullRequestId: details.pullRequestId,
          checks: details.checks ?? [],
          participants: details.participants ?? [],
          assignees: details.assignees
        }
  )
  .nullable()
