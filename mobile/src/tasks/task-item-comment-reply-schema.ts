import { z } from 'zod'
import { prFlag, prText } from '../session/github-pr-entity-reply-schema'
import { taskCommentWriteEnvelopeSchema } from './task-provider-entity-reply-schema'

// What a comment write on a task item answers with, over all three providers. Checked against the
// handlers in src/main/runtime/rpc/methods/ — github-issue-methods.ts:34-39,
// github-pull-request-methods.ts, gitlab.ts, linear.ts:88-93 — and GitHubCommentResult in
// src/shared/github/comment-types.ts, which every GitHub and GitLab comment write returns.

/**
 * The five writes that answer with a comment: both GitHub issue-comment paths, the review comment
 * and its reply, and both GitLab paths.
 *
 * Nothing past the container is required. Every call site reads `ok === false`, raises
 * `error ?? <its own copy>`, and falls back to a locally built row when the reply carries no
 * `comment` (use-mobile-tasks-hosted-comment-review-actions.tsx:103-111 is the shape of all five).
 * The reply's comment is checked rather than adopted blind, so a row the timeline could not key or
 * render leaves that same local echo in place instead of reaching the list as a blank bubble.
 */
export const taskCommentWrittenSchema = taskCommentWriteEnvelopeSchema

/**
 * Linear's comment write, which answers with an id rather than a comment.
 *
 * `id` is optional because use-mobile-tasks-linear-item-actions.tsx:52 reads
 * `result.id ?? 'local-<now>'`: a reply without one still puts the comment the user typed on the
 * sheet, and that is the behaviour worth keeping.
 */
export const linearCommentWrittenSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  id: prText('id')
})

/**
 * Resolving or reopening a review thread.
 *
 * The same boolean reader the file-viewed sync uses, and the session domain's two boolean
 * mutations before it: `interpret(reply) !== true` is the rule at both call sites, so a reply that
 * is not a boolean read as "the write did not happen" — indistinguishable from a host that refused
 * it. A real `false` still reaches that rule and still shows the call site's own copy.
 */
export { githubPrMutationConfirmationSchema as reviewThreadResolvedSchema } from '../session/github-pr-mutation-reply-schema'
