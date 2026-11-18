import { EpochMsSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'

// What happened on a pull request: a check failed, or passed after failing; someone commented or
// reviewed; it merged, closed or reopened.
export const PR_EVENT_TYPES = [
  'check_failed',
  'check_passed',
  'comment',
  'review_comment',
  'review',
  'merged',
  'closed',
  'reopened'
] as const

const Text = z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)

// One event on a pull request its bots' owner opened, for the machine to match to the worker whose
// workspace is that branch at that commit. Never a fork's, nor written by the Orca app itself.
export const PrEventSchema = z.object({
  // The source's own id for it: one wake per key.
  key: z.string().min(1).max(256),
  type: z.enum(PR_EVENT_TYPES),
  // The pull request as a ref (github:<installation>:<repoId>:<number>), for replies through the
  // connector.
  ref: z.string().min(1).max(256),
  repo: z.object({ id: z.string().min(1).max(32), fullName: Text }),
  number: z.number().int().positive(),
  headRef: z.string().min(1).max(256),
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  // Who did it, by login.
  actor: Text.optional(),
  // The pull request's author did it: on a worker's pull request, maybe the worker itself.
  fromAuthor: z.literal(true).optional(),
  // The check that failed or passed.
  check: Text.optional(),
  // A review's verdict: approved, changes_requested or commented.
  reviewState: z.string().min(1).max(32).optional(),
  url: z.string().url().max(2048).optional(),
  // The comment, or the check's summary, as a reader sees it.
  text: z.string().max(CONNECTOR_LIMITS.maxTriggerTextLength).optional(),
  occurredAt: EpochMsSchema
})

export type PrEventType = (typeof PR_EVENT_TYPES)[number]
export type PrEvent = z.infer<typeof PrEventSchema>
