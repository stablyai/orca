import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Base-ref and PR-link consumers fall back on absent hints; salvage those fields without requiring unrelated host metadata.
export const worktreeSummaryReplySchema = z.object({
  worktree: z
    .object({
      baseRef: salvagedOptional('baseRef', z.string()),
      linkedPR: salvagedOptional('linkedPR', z.number()),
      suppressedGitHubPR: salvagedOptional('suppressedGitHubPR', z.number()),
      branch: salvagedOptional('branch', z.string()),
      head: salvagedOptional('head', z.string()),
      isBare: salvagedOptional('isBare', z.boolean()),
      isArchived: salvagedOptional('isArchived', z.boolean()),
      pushTarget: salvagedOptional(
        'pushTarget',
        z.looseObject({ remoteName: z.string(), branchName: z.string() })
      )
    })

    .nullable()
    .optional()
})
