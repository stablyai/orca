import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Page command schemas mirror runtime browser-core and adjacent pointer/keyboard/dialog methods.

// Keep goto payload nullish and URL optional: original typeof result?.url guard leaves address unchanged for null/missing URL, rather than showing an error.
export const browserNavigationSettledSchema = z
  .looseObject({
    url: salvagedOptional('url', z.string())
  })
  .nullish()

// Twelve other commands inspect refusal only (back/forward/reload, five pointer, two keyboard, two dialog); do not require unread result members.
export const browserCommandUnreadReplySchema = z.unknown()
