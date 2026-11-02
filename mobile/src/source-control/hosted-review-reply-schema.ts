import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Require provider for compose routing; preserve unknown tokens that newer hosts may publish.
// Provider round-trips on create, so enum fallback would corrupt the host’s token; gate support at the UI.
export const hostedReviewEligibilitySchema = z.looseObject({
  provider: z.string(),
  canCreate: salvagedOptional('canCreate', z.boolean()),
  blockedReason: salvagedOptional('blockedReason', z.string().nullable()),
  nextAction: salvagedOptional('nextAction', z.string().nullable()),
  reviewLookupOutcome: salvagedOptional('reviewLookupOutcome', z.string()),
  defaultBaseRef: salvagedOptional('defaultBaseRef', z.string().nullable()),
  title: salvagedOptional('title', z.string().nullable()),
  body: salvagedOptional('body', z.string().nullable())
})

const hostedReviewSummarySchema = z.looseObject({ url: z.string(), number: z.number().optional() })

// Success needs number/url for linking; failure error is read unguarded. Existing-review hints remain optional.
export const hostedReviewCreateOkSchema = z.looseObject({
  ok: z.literal(true),
  number: z.number(),
  url: z.string()
})

export const hostedReviewCreateFailedSchema = z.looseObject({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  existingReview: salvagedOptional('existingReview', hostedReviewSummarySchema)
})

export type MobileHostedReviewEligibilityReply = z.output<typeof hostedReviewEligibilitySchema>
export type MobileHostedReviewCreateOk = z.output<typeof hostedReviewCreateOkSchema>
export type MobileHostedReviewCreateFailed = z.output<typeof hostedReviewCreateFailedSchema>
