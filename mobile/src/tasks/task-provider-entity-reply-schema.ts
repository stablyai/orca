import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { prCount, prFlag, prNullableText, prText } from '../session/github-pr-entity-reply-schema'

// The entities the tasks screen's provider replies are built out of: the mutation envelope every
// GitHub/GitLab/Linear write answers with, a conversation comment, an assignable user, a review
// summary, a check row and a changed file. Checked against src/main/github/issue-create.ts,
// issue-update.ts, issue-comment.ts, client/create/add-pr-review-comment.ts and the shared
// GitHubCommentResult / GitHubCreateIssueResult types the host returns from them.
//
// Two rules run through this file and the four schema modules beside it.
//
// 1. A member is required only where a tasks consumer reads it with no guard. Everything the
//    consumer reaches through `?.`, `??` or a `typeof` test stays optional, because main read it
//    that way and a reply without it rendered the same fallback it renders now.
// 2. No member is required that the site's own recorded `normal` reply does not carry. The corpus
//    is the only evidence of what a host really sends at each site, and requiring a member absent
//    from that control would turn a good reply into an incompatible one. Where that rule holds a
//    schema looser than the host's own type, the schema says so at the member.
//
// Member helpers come from the session domain's entity module rather than a second copy: they are
// plain salvaged-member combinators over zod-salvage, and one definition is what keeps "absent
// stays absent, malformed reads as absent" identical on both surfaces.

const DETAIL_REACTION_CONTENT = [
  'thumbs_up',
  'thumbs_down',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
] as const

const DETAIL_FILE_STATUS = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged'
] as const

const VIEWER_VIEWED_STATE = ['DISMISSED', 'VIEWED', 'UNVIEWED'] as const

/**
 * One conversation comment, as every task sheet holds it.
 *
 * `id` and `body` are the only required members, and they are the two `DetailComment` declares
 * non-optional: the timeline keys rows by id and renders body unguarded. Every other member is
 * reached through `?.` or `??` — commentAuthor (mobile-tasks-item-comments.tsx:47) is the shape of
 * all of them — so it stays optional and is passed through exactly as the host sent it. The
 * reaction arm set is closed because the mobile vocabulary (`thumbs_up`) is not GitHub's (`+1`):
 * a row this build cannot name has no glyph to render, so it drops rather than reaching the list.
 */
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
    salvagingArray(
      z.looseObject({ content: z.enum(DETAIL_REACTION_CONTENT), count: z.number().finite() })
    )
  ),
  path: prText('path'),
  line: prCount('line'),
  startLine: prCount('startLine'),
  threadId: prText('threadId'),
  isResolved: prFlag('isResolved')
})

export const detailCommentListSchema = salvagingArray(detailCommentSchema)

/**
 * A user the item can be assigned to or asked to review.
 *
 * `login` is the identity: the reviewer merge reads `reviewer.login.trim()` with no guard
 * (use-mobile-tasks-hosted-comment-review-actions.tsx:180), so a row without one drops rather than
 * taking the whole picker down. `name` and `avatarUrl` keep an explicit `null` — the recorded
 * `github.listAssignableUsers` reply sends `avatarUrl: null`, and collapsing it to `''` would
 * change what the avatar row renders for a good reply.
 */
export const assignableUserSchema = z.looseObject({
  login: z.string(),
  name: prNullableText('name'),
  avatarUrl: prNullableText('avatarUrl')
})

export const assignableUserListSchema = salvagingArray(assignableUserSchema)

/** One review, keyed by `login` the same way. Nested `author.login` is not accepted here: this
 *  surface never read it, and inventing the fallback would widen what the sheet shows. */
export const reviewSummaryListSchema = salvagingArray(
  z.looseObject({
    login: z.string(),
    state: prNullableText('state'),
    avatarUrl: prNullableText('avatarUrl')
  })
)

/**
 * One check row. `name` labels it and `status` drives its icon, and both are read unguarded by the
 * checks list and by summarizeProviderChecks.
 *
 * `status` is a free string rather than the host's `queued | in_progress | completed` arm set,
 * because this surface is fed by two different producers: the recorded `github.prChecks` reply
 * sends `COMPLETED` / `SUCCESS` in caps, and `GitHubDetailCheck` declares both as strings.
 */
export const detailCheckListSchema = salvagingArray(
  z.looseObject({
    name: z.string(),
    status: z.string(),
    conclusion: prNullableText('conclusion'),
    url: prNullableText('url')
  })
)

/** One changed file. `path` is what the expansion, the viewed toggle and the comment anchor are
 *  all keyed on, so a row without one can never match and drops. */
export const detailFileListSchema = salvagingArray(
  z.looseObject({
    path: z.string(),
    oldPath: prText('oldPath'),
    status: salvagedOptional('status', z.enum(DETAIL_FILE_STATUS)),
    additions: prCount('additions'),
    deletions: prCount('deletions'),
    isBinary: prFlag('isBinary'),
    viewerViewedState: salvagedOptional('viewerViewedState', z.enum(VIEWER_VIEWED_STATE))
  })
)

/**
 * The envelope every task mutation answers with, and the reason there is one of it rather than
 * twenty.
 *
 * `ok === false` is the only failure test any of these call sites makes, and `error` is the only
 * text any of them raises. Both stay optional and tri-state: a reply with no `ok` is the success
 * main read, and `ok: false` is a refusal the caller reports with the host's own sentence.
 * `error` is a string because that is what every call site interpolates into `new Error(...)`; a
 * host that answers an object there now reaches the call site's own fallback copy instead of
 * rendering `[object Object]`.
 */
export const taskMutationEnvelopeSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error')
})

/** The mutation envelope a comment write adds its created row to. The row is salvaged, so a
 *  comment the host could not describe leaves the call site's local echo in place. */
export const taskCommentWriteEnvelopeSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  comment: salvagedOptional('comment', detailCommentSchema)
})
