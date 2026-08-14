import { z } from 'zod'
import { OptionalString } from '../schemas'

export const BrowserTabCreateParams = z.object({
  url: OptionalString,
  worktree: OptionalString,
  page: OptionalString,
  profileId: OptionalString,
  waitForRegistration: z.boolean().optional(),
  activate: z.boolean().optional(),
  targetGroupId: OptionalString
})
