import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Ownership routes writes: unreadable routing members must fail, since salvaging them to absent could send a remote mutation locally.

// Keep an absent worktree nullish for the caller’s missing-summary error.
// hostId absent captures local, null refuses an unplaceable owner, and a string is parsed; never salvage a wrong type into local ownership.
export const fileOwnershipWorktreeSchema = z
  .looseObject({
    worktree: z.looseObject({ hostId: z.string().nullable().optional() }).nullish()
  })
  .transform((reply) => reply.worktree)

// Echo connectionGeneration as expectedSshConnectionGeneration; wrong types must fail rather than invent a wire value.
// A missing connection normally returns state:null; an unusable targetId falls through to the caller’s mismatch error.
export const fileOwnershipSshStateSchema = z
  .looseObject({
    state: z
      .looseObject({
        targetId: salvagedOptional('targetId', z.string()),
        connectionGeneration: z.number().optional()
      })
      .nullish()
  })
  .transform((reply) => reply.state)
