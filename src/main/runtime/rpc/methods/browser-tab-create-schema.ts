import { z } from 'zod'
import { OptionalString } from '../schemas'
import { BrowserPageCreationPlacement } from '../../../../shared/browser-client-host-placement'
import { RUNTIME_NAVIGATION_TARGETS } from '../../../../shared/runtime-navigation'

export const BrowserTabCreateParams = z.object({
  url: OptionalString,
  worktree: OptionalString,
  page: OptionalString,
  profileId: OptionalString,
  waitForRegistration: z.boolean().optional(),
  activate: z.boolean().optional(),
  // Why: `activate` says the caller wants the new tab selected; `navigation` says on whose screens.
  // Absent, a paired caller means 'caller' — one device's create must not steer every other UI.
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional(),
  targetGroupId: OptionalString,
  placement: BrowserPageCreationPlacement.optional()
})
