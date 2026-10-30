import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type { GitHubReaction, PRComment } from '../../../src/shared/github/comment-types'
import type {
  GitHubAssignableUser,
  GitHubPRMergeMethodSettings,
  GitHubPRReviewSummary,
  GitHubRepositoryIdentity,
  ProviderCheckSummary
} from '../../../src/shared/github/pull-request-types'
import type { PRCheckDetail } from '../../../src/shared/github/check-types'

// Require entity identity, salvage malformed list members, and default other fields for unguarded renderers.

export const PR_STATE = ['open', 'closed', 'merged', 'draft'] as const
export const CHECK_STATUS = ['pending', 'success', 'failure', 'neutral'] as const
export const MERGEABLE_STATE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const
export const REVIEW_DECISION = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const
const CHECK_RUN_STATUS = ['queued', 'in_progress', 'completed'] as const
// Keep action_required: the shared classifier treats approval gates as failure, not pending.
const CHECK_RUN_CONCLUSION = [
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'neutral',
  'skipped',
  'pending'
] as const
const MERGE_METHOD = ['merge', 'squash', 'rebase'] as const
const CHECK_SUMMARY_STATE = ['success', 'failure', 'pending', 'neutral', 'none'] as const
const REACTION_CONTENT = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
] as const

export function prText(name: string) {
  return salvagedOptional(name, z.string())
}

export function prCount(name: string) {
  return salvagedOptional(name, z.number().finite())
}

export function prFlag(name: string) {
  return salvagedOptional(name, z.boolean())
}

// Preserve explicit null: the sidebar distinguishes it from an absent flag.
export function prNullableFlag(name: string) {
  return salvagedOptional(name, z.boolean().nullable())
}

export function prNullableText(name: string) {
  return salvagedOptional(name, z.string().nullable())
}

export function prStringList(name: string) {
  return salvagedOptional(name, salvagingArray(z.string()))
}

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

// Accept desktop’s top-level login and raw gh’s author.login so neither host shape loses reviewers.
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

// Require nonempty fork identity and preserve host so GHES actions cannot fall back to github.com.
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
    reactions: comment.reactions?.length ? comment.reactions : undefined,
    path: comment.path,
    threadId: comment.threadId,
    isResolved: comment.isResolved,
    isOutdated: comment.isOutdated,
    line: comment.line,
    startLine: comment.startLine,
    isBot: comment.isBot
  }))

// Preserve upstream order because timeline thread grouping depends on it.
export function prCommentList(name: string) {
  return salvagedOptional(name, salvagingArray(prCommentSchema))
}

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
