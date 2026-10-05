import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Unresolved worktrees stay readable so capture reports its existing owner-verification refusal.
export const fileOwnershipWorktreeSchema = z
  .looseObject({
    worktree: z.looseObject({ hostId: z.string().nullable().optional() }).nullish()
  })
  .transform((reply) => reply.worktree)

// The host-issued generation is echoed on writes; unreadable generations must never be substituted.
export const fileOwnershipSshStateSchema = z
  .looseObject({
    state: z
      .looseObject({
        targetId: salvagedOptional('targetId', z.string()),
        status: salvagedOptional('status', z.string()),
        connectionGeneration: z.number().optional()
      })
      .nullish()
  })
  .transform((reply) => reply.state)
