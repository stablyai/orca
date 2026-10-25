import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Base-ref and PR-link consumers fall back on absent hints; salvage those fields without requiring unrelated host metadata.
export const worktreeSummaryReplySchema = z.object({
  worktree: z
    .object({
      baseRef: salvagedOptional('baseRef', z.string()),
      linkedPR: salvagedOptional('linkedPR', z.number())
    })

    .nullable()
    .optional()
})
