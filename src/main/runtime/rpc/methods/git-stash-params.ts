import { z } from 'zod'
import { WorktreeSelector } from './git-params'
import { MAX_STASH_MESSAGE_LENGTH } from '../../../../shared/git-stash-commands'

// Why: only git's own `stash@{N}` shape. A `-`-prefixed or free-form rev here
// would reach a destructive subcommand as a flag or an unintended target.
const StashRef = z
  .unknown()
  .transform((v) => (typeof v === 'string' ? v : ''))
  .pipe(z.string().regex(/^stash@\{\d+\}$/, 'Expected a stash ref like stash@{0}'))

const ExpectedStashCommitOid = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, 'Expected a full git object id')

export const GitStashSelector = WorktreeSelector

export const GitStashPush = WorktreeSelector.extend({
  includeUntracked: z.boolean().optional(),
  message: z.string().min(1).max(MAX_STASH_MESSAGE_LENGTH).optional()
})

/**
 * `ref` omitted targets the newest entry; `expectedCommitOid` is the oid the
 * client saw when it listed, so a concurrent stash cannot silently retarget the
 * operation at a different entry.
 */
export const GitStashRestore = WorktreeSelector.extend({
  ref: StashRef.optional(),
  expectedCommitOid: ExpectedStashCommitOid.optional()
})

export const GitStashDrop = WorktreeSelector.extend({
  ref: StashRef,
  expectedCommitOid: ExpectedStashCommitOid.optional()
})
