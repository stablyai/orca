import { z } from 'zod'
import { prCount, prFlag, prText } from '../session/github-pr-entity-reply-schema'
import {
  detailCheckListSchema,
  taskMutationEnvelopeSchema
} from './task-provider-entity-reply-schema'

// What a task item's writes answer with, plus the two PR reads that go with them. Checked against
// the handlers in src/main/runtime/rpc/methods/ — github-issue-methods.ts:16-33,
// github-pull-request-methods.ts:84-92, github-pull-request-update-methods.ts, gitlab.ts,
// linear.ts:58-87 — and the shared results they return: GitHubCreateIssueResult and
// GitHubIssueUpdate's `{ ok } | { ok, error }` in src/shared/issue-mutation-types.ts,
// GitHubCommentResult in src/shared/github/comment-types.ts, and GitHubPRFileContents in
// src/shared/github/pull-request-types.ts.

/**
 * Creating a GitHub or GitLab issue.
 *
 * Nothing is required beyond the envelope itself: use-mobile-tasks-task-create-actions.tsx:83
 * tests `ok === false`, :88 gates the optimistic row on `typeof number === 'number'` and :98 reads
 * `url ?? ''`. What the schema adds is the container — main read `result.ok` off a string reply
 * and silently reported success, and off a `null` one it threw a property-read TypeError.
 */
export const hostedIssueCreatedSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  number: prCount('number'),
  url: prText('url')
})

/**
 * Creating a Linear issue, from the composer or from the sub-issue field.
 *
 * Also all-optional, for the same reason: both call sites gate on
 * `result.ok === false || !result.id || !result.identifier`
 * (use-mobile-tasks-task-create-actions.tsx:140, use-mobile-tasks-linear-item-actions.tsx:138) and
 * read `title` and `url` behind `??`. `id` and `identifier` are therefore a refusal the call site
 * already words, not a decode failure.
 */
export const linearIssueCreatedSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  id: prText('id'),
  identifier: prText('identifier'),
  title: prText('title'),
  url: prText('url')
})

/**
 * The state and metadata writes: both issue edits, both pull/merge-request edits, both state
 * toggles, the reviewer request, the checks rerun and both merges.
 *
 * One schema for nine methods, because there is one convention and no input on which two of them
 * would want different answers: every call site reads `ok === false` and raises `error` or its own
 * copy. Kept separate from the session domain's `githubPrMutationStatusSchemas` even where the
 * method matches, because that reader answers a `{ structured, ok, error }` verdict its own
 * outcome module discriminates, where these call sites read the two members directly.
 */
export const taskItemMutationSchema = taskMutationEnvelopeSchema

/**
 * The checks list behind the item sheet's Checks panel and the project row's.
 *
 * An array, and each row needs the `name` and `status` the list renders unguarded; a row without
 * either drops rather than failing the refresh. Both call sites hand the decoded list straight to
 * `buildGitHubCheckSummary`, whose classifier reads the same two members
 * (use-mobile-tasks-hosted-comment-review-actions.tsx:256).
 */
export const githubPullRequestChecksSchema = detailCheckListSchema

/**
 * One file's two sides of a pull-request diff.
 *
 * Every member is optional even though `getPRFileContents`
 * (src/main/github/pull-request-file-contents.ts:121) always returns the first four. The corpus is
 * why: the recorded `normal` reply at both sites is `{ oldContent, newContent, truncated }`, a
 * shape the host cannot produce, so requiring `original` would reject this surface's only success
 * control. The call site reads nothing off the payload — it files it under the file path and the
 * diff view reads it later — so nothing here is a member this reader can justify requiring.
 * What the schema does add is the container: a string or a `null` reply is now named.
 */
export const githubPullRequestFileContentsSchema = z.looseObject({
  original: prText('original'),
  modified: prText('modified'),
  originalIsBinary: prFlag('originalIsBinary'),
  modifiedIsBinary: prFlag('modifiedIsBinary'),
  originalTooLarge: prFlag('originalTooLarge'),
  modifiedTooLarge: prFlag('modifiedTooLarge')
})

/**
 * Syncing one file's viewed state.
 *
 * `z.boolean()`, the same reader the session domain's two boolean mutations use: `!== true` is the
 * confirmation rule at both call sites (use-mobile-tasks-project-review-check-actions.tsx:219,
 * use-mobile-tasks-github-check-file-actions.tsx:99), so a non-boolean read as "not confirmed" was
 * indistinguishable from a host that declined the write. A real `false` still reaches that rule.
 */
export { githubPrMutationConfirmationSchema as taskMutationConfirmationSchema } from '../session/github-pr-mutation-reply-schema'

/**
 * Setting a Linear issue's workflow state.
 *
 * The reply body is unread: use-mobile-tasks-github-reply-merge-actions.tsx:207 interprets the
 * envelope for its acceptance and looks at nothing in it, so there is no member to declare. The
 * acceptance still carries a refusal to the callback's `catch`, which is the whole verdict here.
 */
export const linearIssueUpdatedSchema = z.unknown()
