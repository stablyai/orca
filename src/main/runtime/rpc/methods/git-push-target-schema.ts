import { z } from 'zod'

export const GitPushTargetParam = z.object({
  remoteName: z.string(),
  branchName: z.string(),
  remoteUrl: z.string().optional(),
  remoteCreated: z.boolean().optional(),
  reviewHead: z
    .object({
      provider: z.enum(['github', 'gitlab']),
      host: z.string().min(1),
      repository: z.string().min(1),
      branchName: z.string().min(1)
    })
    .optional()
})
