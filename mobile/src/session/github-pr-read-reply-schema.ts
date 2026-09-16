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

// The seven `github.*` / `hostedReview.*` replies the PR sidebar reads. Each schema requires the
// members that identified the entity for main — the ones whose absence made it answer `null` — and
// applies main's own default to everything else, because the shared types declare those members
// non-optional and the sidebar renders them unguarded.
//
// What changes: a payload that is not the declared container at all (a string, a number, an
// envelope) is an incompatible reply instead of the empty answer main gave it. "No pull request"
// and "no hosted review" are still `null`, because the host really sends `null` for both.

const HOSTED_REVIEW_STATE = ['open', 'closed', 'merged', 'draft'] as const
const HOSTED_REVIEW_PROVIDER = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea',
  'unsupported'
] as const

/**
 * Whether the worktree's repo has a GitHub remote, which gates the dedicated PR-view icon.
 *
 * `owner` and `repo` are required because they are the slug: main answered null without either, so
 * every caller already reads null as "no GitHub remote". Empty strings are accepted, exactly as
 * main's `typeof === 'string'` test did, while `host` is carried only when non-empty.
 */
export const githubPrRepoSlugSchema = z
  .looseObject({ owner: z.string(), repo: z.string(), host: prText('host') })
  .transform((slug) => ({
    owner: slug.owner,
    repo: slug.repo,
    ...(slug.host ? { host: slug.host } : {})
  }))
  .nullable()

/**
 * The hosted review on this branch, or `null` when there is none.
 *
 * `provider` and `number` are the identity the Create gate decides on, and main answered null
 * without either — including for a provider it did not recognise, which is why the arm set is
 * closed and degrades to the same null rather than to an arm. Nothing is sent back to the host
 * from here: mobile-pr-sidebar-state.ts:91 only compares the token to `'github'`.
 */
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
          autoMergeAllowed: review.autoMergeAllowed ?? undefined,
          mergeStateStatus: review.mergeStateStatus,
          headSha: review.headSha
        }
  )
  .nullable()

/**
 * A pull request body, wherever it is carried.
 *
 * `number` and `state` are the identity: main answered null without either, and the sidebar has
 * nothing to render for a PR with no number. `prRepo` and `mergeMethodSettings` are what the
 * checks panel and the merge picker are keyed on, so both survive parsing rather than being
 * dropped with the rest.
 */
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
          autoMergeAllowed: pr.autoMergeAllowed ?? undefined,
          mergeQueueRequired: pr.mergeQueueRequired ?? undefined,
          mergeStateStatus: pr.mergeStateStatus,
          headSha: pr.headSha,
          prRepo: pr.prRepo,
          mergeMethodSettings: pr.mergeMethodSettings
        }
  )

/**
 * What the branch lookup answers, which is not what the host's own refresh type carries.
 *
 * `PRRefreshOutcome` has an `errorType` and a `fetchedAt` this reply never contains, and the only
 * consumer (github-pr-rpc.ts) reads neither — so the reader declares the two members it does read
 * rather than fabricating the other two to satisfy a type it is not producing.
 */
export type GitHubPrForBranchOutcome =
  | { kind: 'upstream-error'; message: string }
  | { kind: 'found'; pr: PRInfo }

/**
 * The branch lookup's whole answer, outcome classification included.
 *
 * Legacy hosts answer a bare PR or `null`; current hosts answer a classified refresh outcome. Both
 * are declared here rather than normalized first, so the `upstream-error` arm keeps the host's own
 * message — the sidebar has surfaced that text since before the classification existed, and a
 * decode failure could not carry it. Which arm becomes an error is the call site's decision, not
 * the reader's: an error the host reported in-band is not a reply this app could not read.
 */
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
    // The legacy arm: a bare PRInfo, or `null` for no pull request.
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

/**
 * The work-item detail pane.
 *
 * `item` is required and answers for the whole reply: main returned null when it would not parse,
 * and the pane has no header, no state and no actions without it. Everything beside it is a list
 * the pane renders empty when the host sends none.
 */
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
    // `assignees` stays absent rather than empty when the host sends no array, because the detail
    // pane distinguishes "no assignees" from "this host does not report them".
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

export type GitHubPrRepoSlugReply = z.output<typeof githubPrRepoSlugSchema>
