import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Require unguarded members, salvage typed guards to their existing fallbacks, and retain unknown for truthiness-only reads.

// Require content because the Markdown disk fallback publishes it unguarded; the preview screen maps a missing string to the same load error.
// Salvage truncated/byteLength to guarded fallbacks. These methods raise binary_file rather than sending isBinary, but the projection still reads it.
export const filePreviewTextSchema = z.looseObject({
  content: z.string(),
  truncated: salvagedOptional('truncated', z.boolean()),
  byteLength: salvagedOptional('byteLength', z.number()),
  isBinary: salvagedOptional('isBinary', z.boolean())
})

// Salvage every member: the image normalizer guards them all and accepts host replies lacking mime or marking mobile’s guessed image as nonbinary.
// Require only the container so malformed replies name the reply failure rather than blaming the file.
export const filePreviewImageSchema = z.looseObject({
  content: salvagedOptional('content', z.string()),
  isBinary: salvagedOptional('isBinary', z.boolean()),
  isImage: salvagedOptional('isImage', z.boolean()),
  mimeType: salvagedOptional('mimeType', z.string())
})

// The grant-refresh guard treats unusable members as not refreshable, a normal outcome; salvage them and require only the container.
export const terminalPathResolutionSchema = z.looseObject({
  exists: salvagedOptional('exists', z.boolean()),
  isDirectory: salvagedOptional('isDirectory', z.boolean()),
  openTarget: salvagedOptional(
    'openTarget',
    z.looseObject({
      kind: salvagedOptional('kind', z.string()),
      absolutePath: salvagedOptional('absolutePath', z.string()),
      grantId: salvagedOptional('grantId', z.string()),
      readOnly: salvagedOptional('readOnly', z.literal(true))
    })
  )
})

// Save callers read acceptance only; require no reply members.
export const terminalArtifactWriteSchema = z.unknown()
