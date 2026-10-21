import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

/**
 * The `worktree.show` members the two source-control readers take: branch compare wants
 * `worktree.baseRef` and the PR sidebar wants `worktree.linkedPR`.
 *
 * Both are salvaged optionals, and the wrapper is nullable, because both callers fall back to
 * another source when the hint is missing — mobile-branch-base-ref.ts:25 and mobile-pr-link.ts:119.
 * The host's worktree record carries dozens of members mobile never reads; declaring only these two
 * keeps a host that renames an unrelated field from breaking the base-ref chain.
 */
export const worktreeSummaryReplySchema = z.object({
  worktree: z
    .object({
      baseRef: salvagedOptional('baseRef', z.string()),
      linkedPR: salvagedOptional('linkedPR', z.number())
    })

    .nullable()
    .optional()
})
