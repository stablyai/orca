import { z } from 'zod'

const WorkspaceCleanupDismissal = z
  .object({
    worktreeId: z.string(),
    dismissedAt: z.number().finite(),
    fingerprint: z.string(),
    classifierVersion: z.number().finite()
  })
  .strict()

export const WorkspaceCleanup = z
  .object({
    dismissals: z.record(z.string(), WorkspaceCleanupDismissal)
  })
  .strict()
