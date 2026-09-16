import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type {
  GitHubReaction,
  GitHubReactionContent,
  PRComment
} from '../../../src/shared/github/comment-types'
import type {
  GitHubAssignableUser,
  GitHubPRMergeMethodSettings,
  GitHubPRReviewSummary,
  GitHubRepositoryIdentity,
  ProviderCheckSummary
} from '../../../src/shared/github/pull-request-types'
import type { PRCheckDetail } from '../../../src/shared/github/check-types'

// The entities the `github.*` PR reads are built out of: users, review summaries, repo identities,
// merge settings, check summaries, conversation comments and check rows. Checked against
// src/shared/github/pull-request-types.ts, comment-types.ts and check-types.ts, which
// src/main/runtime/rpc/methods/github-pull-request-methods.ts returns from the GitHub client
// verbatim.
//
// One rule runs through the file: a member the entity is *identified* by is required, and an entity
// missing one drops out of its list rather than failing the whole reply — which is what main's
// `return null` inside a `flatMap` did. Everything else is a salvaged optional with main's own
// default applied in the transform, because the shared types declare those members non-optional and
// every renderer reads them unguarded.

export const PR_STATE = ['open', 'closed', 'merged', 'draft'] as const
export const CHECK_STATUS = ['pending', 'success', 'failure', 'neutral'] as const
export const MERGEABLE_STATE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const
export const REVIEW_DECISION = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const
export const CHECK_RUN_STATUS = ['queued', 'in_progress', 'completed'] as const
// `action_required` stays in the set: dropping it rendered a merge-blocking approval gate as a
// pending check, because the shared classifier counts it as a failure.
export const CHECK_RUN_CONCLUSION = [
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'neutral',
  'skipped',
  'pending'
] as const
export const MERGE_METHOD = ['merge', 'squash', 'rebase'] as const
export const CHECK_SUMMARY_STATE = ['success', 'failure', 'pending', 'neutral', 'none'] as const
export const REACTION_CONTENT = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
] as const

/** A string member that reads as absent when the host sends something else. */
export function prText(name: string) {
  return salvagedOptional(name, z.string())
}

/** A number member; non-finite reads as absent, the way `Number.isFinite` gated main's. */
export function prCount(name: string) {
  return salvagedOptional(name, z.number().finite())
}

export function prFlag(name: string) {
  return salvagedOptional(name, z.boolean())
}

/** A tri-state member: an explicit `null` is a value the sidebar routes on, not an absence. */
export function prNullableFlag(name: string) {
  return salvagedOptional(name, z.boolean().nullable())
}

export function prNullableText(name: string) {
  return salvagedOptional(name, z.string().nullable())
}

/** A list that reads as empty when the host sends no array, which is what `readStringArray` did. */
export function prStringList(name: string) {
  return salvagedOptional(name, salvagingArray(z.string()))
}

/** `login` identifies the user; a row without one was never rendered. */
const assignableUserSchema = z
  .looseObject({
    login: z.string(),
    name: prText('name'),
    avatarUrl: prText('avatarUrl')
  })
  .transform((user): GitHubAssignableUser => ({
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? ''
  }))

export function prUserList(name: string) {
  return salvagedOptional(name, salvagingArray(assignableUserSchema))
}

export const assignableUsersSchema = salvagingArray(assignableUserSchema)

/**
 * One review.
 *
 * Desktop maps `latestReviews` to a top-level `login`; raw `gh pr view --json` keeps a nested
 * `author.login`. Both are accepted so mobile never drops a reviewer, which is why `login` is
 * assembled in the transform rather than declared required at the top level.
 */
const reviewSummarySchema = z
  .looseObject({
    login: prText('login'),
    state: prText('state'),
    avatarUrl: prText('avatarUrl'),
    author: salvagedOptional(
      'author',
      z.looseObject({
        login: prText('login'),
        avatarUrl: prText('avatarUrl'),
        avatar_url: prText('avatar_url')
      })
    )
  })
  .transform((review, ctx): GitHubPRReviewSummary => {
    const login = review.login ?? review.author?.login
    if (login === undefined) {
      ctx.addIssue({ code: 'custom', message: 'review has no login', input: review })
      return z.NEVER
    }
    return {
      login,
      state: review.state ?? null,
      avatarUrl: review.avatarUrl ?? review.author?.avatarUrl ?? review.author?.avatar_url ?? null
    }
  })

export function prReviewList(name: string) {
  return salvagedOptional(name, salvagingArray(reviewSummarySchema))
}

/**
 * The head repo a fork PR's checks and merge are keyed on.
 *
 * Empty owner or repo is malformed rather than a valid identity, so `.min(1)` keeps main's falsy
 * drop. `host` is carried because dropping it strips the GitHub Enterprise identity before every
 * subsequent PR RPC, forcing the host to re-derive it per call.
 */
const repoIdentitySchema = z
  .looseObject({ owner: z.string().min(1), repo: z.string().min(1), host: prText('host') })
  .transform((identity): GitHubRepositoryIdentity => ({
    owner: identity.owner,
    repo: identity.repo,
    ...(identity.host ? { host: identity.host } : {})
  }))

export function prRepoIdentity(name: string) {
  return salvagedOptional(name, repoIdentitySchema)
}

/** `defaultMethod` decides which methods the merge picker may offer, so a settings block without a
 *  readable one is no settings block at all. */
const mergeMethodSettingsSchema = z
  .looseObject({
    defaultMethod: z.enum(MERGE_METHOD),
    allowedMethods: z.looseObject({
      merge: prFlag('merge'),
      squash: prFlag('squash'),
      rebase: prFlag('rebase')
    })
  })
  .transform((settings): GitHubPRMergeMethodSettings => ({
    defaultMethod: settings.defaultMethod,
    allowedMethods: {
      merge: settings.allowedMethods.merge ?? false,
      squash: settings.allowedMethods.squash ?? false,
      rebase: settings.allowedMethods.rebase ?? false
    }
  }))

export function prMergeMethodSettings(name: string) {
  return salvagedOptional(name, mergeMethodSettingsSchema)
}

/** `state` is the summary; the counts are all defaulted, so a block without a state is dropped. */
const checkSummarySchema = z
  .looseObject({
    state: z.enum(CHECK_SUMMARY_STATE),
    total: prCount('total'),
    passed: prCount('passed'),
    failed: prCount('failed'),
    pending: prCount('pending'),
    neutral: prCount('neutral')
  })
  .transform((summary): ProviderCheckSummary => ({
    state: summary.state,
    total: summary.total ?? 0,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    pending: summary.pending ?? 0,
    neutral: summary.neutral ?? 0
  }))

export function prCheckSummary(name: string) {
  return salvagedOptional(name, checkSummarySchema)
}

const reactionSchema = z
  .looseObject({ content: z.enum(REACTION_CONTENT), count: z.number().finite() })
  .transform((reaction): GitHubReaction => ({ content: reaction.content, count: reaction.count }))

/** One conversation comment. `id` is the identity the timeline keys and threads by. */
const prCommentSchema = z
  .looseObject({
    id: z.number().finite(),
    author: prText('author'),
    authorAvatarUrl: prText('authorAvatarUrl'),
    body: prText('body'),
    createdAt: prText('createdAt'),
    url: prText('url'),
    reactions: salvagedOptional('reactions', salvagingArray(reactionSchema)),
    path: prText('path'),
    threadId: prText('threadId'),
    isResolved: prFlag('isResolved'),
    isOutdated: prFlag('isOutdated'),
    line: prCount('line'),
    startLine: prCount('startLine'),
    isBot: prFlag('isBot')
  })
  .transform((comment): PRComment => ({
    id: comment.id,
    author: comment.author ?? '',
    authorAvatarUrl: comment.authorAvatarUrl ?? '',
    body: comment.body ?? '',
    createdAt: comment.createdAt ?? '',
    url: comment.url ?? '',
    // An empty reaction list reads as absent, so the timeline renders no reaction row at all.
    reactions: comment.reactions?.length ? comment.reactions : undefined,
    path: comment.path,
    threadId: comment.threadId,
    isResolved: comment.isResolved,
    isOutdated: comment.isOutdated,
    line: comment.line,
    startLine: comment.startLine,
    isBot: comment.isBot
  }))

/** Preserves upstream order — the timeline relies on it for thread grouping. */
export function prCommentList(name: string) {
  return salvagedOptional(name, salvagingArray(prCommentSchema))
}

/** One check row. `name` labels it and `status` decides its icon, so neither can be defaulted. */
const checkDetailSchema = z
  .looseObject({
    name: z.string(),
    status: z.enum(CHECK_RUN_STATUS),
    conclusion: salvagedOptional('conclusion', z.enum(CHECK_RUN_CONCLUSION)),
    url: prText('url'),
    checkRunId: prCount('checkRunId'),
    workflowRunId: prCount('workflowRunId')
  })
  .transform((check): PRCheckDetail => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion ?? null,
    url: check.url ?? null,
    checkRunId: check.checkRunId,
    workflowRunId: check.workflowRunId
  }))

export const prChecksSchema = salvagingArray(checkDetailSchema)

export function prCheckList(name: string) {
  return salvagedOptional(name, prChecksSchema)
}

export type GitHubReactionContentToken = GitHubReactionContent
