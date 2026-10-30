import { z } from 'zod'
import { prCount, prFlag, prText } from '../session/github-pr-entity-reply-schema'
import {
  detailCheckListSchema,
  taskMutationEnvelopeSchema
} from './task-provider-entity-reply-schema'

// Require the result container; issue-create consumers already guard each member and build their own fallbacks.
export const hostedIssueCreatedSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  number: prCount('number'),
  url: prText('url')
})

// Missing id/identifier is an in-band create failure the caller words, not a decode failure.
export const linearIssueCreatedSchema = z.looseObject({
  ok: prFlag('ok'),
  error: prText('error'),
  id: prText('id'),
  identifier: prText('identifier'),
  title: prText('title'),
  url: prText('url')
})

// Task writes share direct ok/error readers; session readers expose a different discriminated verdict.
export const taskItemMutationSchema = taskMutationEnvelopeSchema

// Drop rows without name/status, which both checks panels and the shared classifier read unguarded.
export const githubPullRequestChecksSchema = detailCheckListSchema

// Require a diff container only; consumers guard contents and flags, including absent too-large markers.
export const githubPullRequestFileContentsSchema = z.looseObject({
  original: prText('original'),
  modified: prText('modified'),
  originalIsBinary: prFlag('originalIsBinary'),
  modifiedIsBinary: prFlag('modifiedIsBinary'),
  originalTooLarge: prFlag('originalTooLarge'),
  modifiedTooLarge: prFlag('modifiedTooLarge')
})

// Only true confirms viewed-state writes; preserve false for the caller’s failure copy.
export { githubPrMutationConfirmationSchema as taskMutationConfirmationSchema } from '../session/github-pr-mutation-reply-schema'

// Preserve existing behavior: Linear’s in-band failure payload is unread here; only outer refusal raises an error.
export const linearIssueUpdatedSchema = z.unknown()
