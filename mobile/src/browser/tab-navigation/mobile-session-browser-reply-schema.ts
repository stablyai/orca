import * as z from 'zod'
import { salvagedOptional, salvagingArray } from '../../../../src/shared/validation/zod-salvage'

// Require the reply object; browserPageId is only a guarded optional focus hint.
export const browserTabCreatedSchema = z.looseObject({
  browserPageId: salvagedOptional('browserPageId', z.string())
})

// The phone only names and offers profiles, so it reads id and label and keeps the rest of a row.
export const browserProfileListSchema = z
  .looseObject({
    profiles: salvagingArray(z.looseObject({ id: z.string(), label: z.string() }))
  })
  .transform(({ profiles }) => profiles.map(({ id, label }) => ({ id, label })))
