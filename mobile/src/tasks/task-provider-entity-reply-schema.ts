import { z } from 'zod'
import type { GitHubPRFile } from '../../../src/shared/github/pull-request-types'
import { hostUnionArms, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { prCount, prFlag, prNullableText, prText } from '../session/github-pr-entity-reply-schema'

// Require unguarded consumer fields and salvage guarded members; reuse session combinators to keep absence semantics aligned.

export const DETAIL_FILE_STATUS = hostUnionArms<GitHubPRFile['status']>({
  added: true,
  modified: true,
  removed: true,
  renamed: true,
  copied: true,
  changed: true,
  unchanged: true
})

// Comments need id/body; reactions require only count because GitHub and GitLab disagree on content vocabulary.
export const detailCommentSchema = z.looseObject({
  id: z.union([z.string(), z.number().finite()]),
  author: prText('author'),
  authorAvatarUrl: prText('authorAvatarUrl'),
  user: salvagedOptional('user', z.looseObject({ displayName: prText('displayName') })),
  isBot: prFlag('isBot'),
  body: z.string(),
  createdAt: prText('createdAt'),
  url: prText('url'),
  reactions: salvagedOptional(
    'reactions',
    salvagingArray(z.looseObject({ content: prText('content'), count: z.number().finite() }))
  ),
  path: prText('path'),
  line: prCount('line'),
  startLine: prCount('startLine'),
  threadId: prText('threadId'),
  isResolved: prFlag('isResolved')
})

export const detailCommentListSchema = salvagingArray(detailCommentSchema)

// Require login for unguarded reviewer matching; preserve explicit null name/avatar values.
const assignableUserSchema = z.looseObject({
  login: z.string(),
  name: prNullableText('name'),
  avatarUrl: prNullableText('avatarUrl')
})

export const assignableUserListSchema = salvagingArray(assignableUserSchema)

// Review identity is flat login; nested author.login was never a supported fallback here.
export const reviewSummaryListSchema = salvagingArray(
  z.looseObject({
    login: z.string(),
    state: prNullableText('state'),
    avatarUrl: prNullableText('avatarUrl')
  })
)

// Both check producers use name/status unguarded; keep status open because they differ in case and vocabulary.
export const detailCheckListSchema = salvagingArray(
  z.looseObject({
    name: z.string(),
    status: z.string(),
    conclusion: prNullableText('conclusion'),
    url: prNullableText('url')
  })
)

// Changed files need path; viewed state stays open because it is only compared locally.
// Status round-trips to host validation, so unknown arms become absent and use the caller’s modified fallback.
export const detailFileListSchema = salvagingArray(
  z.looseObject({
    path: z.string(),
    oldPath: prText('oldPath'),
    status: salvagedOptional('status', z.enum(DETAIL_FILE_STATUS)),
    additions: prCount('additions'),
    deletions: prCount('deletions'),
    isBinary: prFlag('isBinary'),
    viewerViewedState: prText('viewerViewedState')
  })
)

// Only explicit ok: false fails; preserve optional fields and fall back on malformed error text.
export const taskMutationEnvelopeSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error')
})

// An unreadable returned comment leaves the caller’s local echo in place.
export const taskCommentWriteEnvelopeSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  comment: salvagedOptional('comment', detailCommentSchema)
})
