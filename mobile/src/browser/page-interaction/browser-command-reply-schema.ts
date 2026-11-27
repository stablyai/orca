import * as z from 'zod'
import { salvagedOptional } from '../../../../src/shared/validation/zod-salvage'

// Page command schemas mirror runtime browser-core and adjacent pointer/keyboard/dialog methods.

// Keep goto payload nullish and URL optional: original typeof result?.url guard leaves address unchanged for null/missing URL, rather than showing an error.
export const browserNavigationSettledSchema = z
  .looseObject({
    url: salvagedOptional('url', z.string())
  })
  .nullish()

// Twelve other commands inspect refusal only (back/forward/reload, five pointer, two keyboard, two dialog); do not require unread result members.
export const browserCommandUnreadReplySchema = z.unknown()

// Open string: a newer host's outcome still reads; only 'answered' means the page got the answer.
export const browserPagePromptAnswerReplySchema = z.looseObject({ result: z.string() })

// Reason stays an open string so a newer host's reason still reads as a refusal.
export const browserCertificateProceedReplySchema = z.looseObject({
  ok: z.boolean(),
  reason: salvagedOptional('reason', z.string())
})
