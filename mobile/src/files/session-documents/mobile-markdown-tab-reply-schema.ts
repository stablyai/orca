import * as z from 'zod'
import { salvagedOptional } from '../../../../src/shared/zod-salvage'

// Require editor content/version/dirty state; host capability and truncation metadata remain optional for compatibility.
export const markdownTabDocumentSchema = z.looseObject({
  content: z.string(),
  version: z.string(),
  isDirty: z.boolean(),
  editable: salvagedOptional('editable', z.boolean()),
  readOnlyReason: salvagedOptional('readOnlyReason', z.string()),
  truncated: salvagedOptional('truncated', z.boolean()),
  byteLength: salvagedOptional('byteLength', z.number())
})
