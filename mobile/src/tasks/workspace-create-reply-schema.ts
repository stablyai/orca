import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

const createText = (name: string) => salvagedOptional(name, z.string())

// Require worktree.id for routing, but allow empty ids so the caller retains its failed-create verdict.
// Preserve warning whitespace; consumers trim it themselves.
export const worktreeCreateReceiptSchema = z.looseObject({
  worktree: z.looseObject({ id: z.string(), displayName: createText('displayName') }),
  warning: createText('warning')
})

// Guarded launch receipt fields remain optional; the mode-blind caller reports missing ids as failed creation.
export const agentLaunchCreateReceiptSchema = z.looseObject({
  worktreeId: createText('worktreeId'),
  warning: createText('warning'),
  outcome: z.unknown().optional(),
  receipt: z.unknown().optional(),
  prompt: z.unknown().optional()
})

// Put soft-error first, including empty messages; resolved replies need baseBranch and pass other fields through to create.
export type WorktreeHostedBaseReply =
  | { error: string }
  | {
      baseBranch: string
      compareBaseRef?: string
      branchNameOverride?: string
      headSha?: string
      maintainerCanModify?: boolean
      pushTarget?: unknown
    }

// Annotate the union so error-in-result narrows despite looseObject’s index signature; runtime fields still pass through.
export const worktreeHostedBaseSchema: z.ZodType<WorktreeHostedBaseReply, unknown> = z.union([
  z.looseObject({ error: z.string() }),
  z.looseObject({
    baseBranch: z.string(),
    compareBaseRef: createText('compareBaseRef'),
    branchNameOverride: createText('branchNameOverride'),
    headSha: createText('headSha'),
    maintainerCanModify: salvagedOptional('maintainerCanModify', z.boolean()),
    pushTarget: z.unknown().optional()
  })
])
