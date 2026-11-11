import * as z from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Require the reply object; browserPageId is only a guarded optional focus hint.
export const browserTabCreatedSchema = z.looseObject({
  browserPageId: salvagedOptional('browserPageId', z.string())
})
