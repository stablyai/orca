import { z } from 'zod'
import { OptionalPlainString, requiredString } from '../schemas'

export const CapabilityCreate = z.object({
  page: requiredString('Missing required --page'),
  worktree: OptionalPlainString,
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(2 * 60 * 60 * 1_000)
})

export const CapabilityRevoke = z.object({
  id: requiredString('Missing required --capability')
})
