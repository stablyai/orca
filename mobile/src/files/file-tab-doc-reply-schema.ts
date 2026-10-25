import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Tabs publish members directly into ready documents; their readers must be stricter than the preview screen’s guarded normalizers.

// Require content, truncated and byteLength because the ready tab publishes all three unguarded.
export const fileTabTextSchema = z.looseObject({
  content: z.string(),
  truncated: z.boolean(),
  byteLength: z.number()
})

// Require content for unguarded base64 replacement. Reject wrong-typed mimeType rather than changing the caller’s load error to binary-unavailable copy.
// Keep isImage unknown because the tab tests truthiness, not strict true.
export const fileTabImageSchema = z.looseObject({
  content: z.string(),
  isImage: z.unknown().optional(),
  mimeType: z.string().optional()
})

// Require both text sides because buildMobileDiffLines reads their lengths unguarded.
const fileTabTextDiffSchema = z.looseObject({
  kind: z.literal('text'),
  originalContent: z.string(),
  modifiedContent: z.string()
})

// Unknown kind strings follow the caller’s non-text branch; exclude text so missing text content cannot masquerade as an unpreviewable binary.
// Normalize kind to binary only for client discrimination; no consumer forwards it. Salvage guarded members, but reject wrong-typed mimeType as the image tab does.
const fileTabBinaryDiffSchema = z.looseObject({
  kind: z
    .string()
    .refine((kind) => kind !== 'text', 'not the text arm')
    .transform(() => 'binary' as const),
  originalContent: salvagedOptional('originalContent', z.string()),
  modifiedContent: salvagedOptional('modifiedContent', z.string()),
  isImage: salvagedOptional('isImage', z.boolean()),
  modifiedDeleted: salvagedOptional('modifiedDeleted', z.boolean()),
  mimeType: z.string().optional()
})

export type MobileFileTabDiff =
  | z.output<typeof fileTabTextDiffSchema>
  | z.output<typeof fileTabBinaryDiffSchema>

export { fileTabBinaryDiffSchema, fileTabTextDiffSchema }
