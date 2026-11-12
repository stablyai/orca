import * as z from 'zod'
import { CLIPBOARD_IMAGE_MAX_SOURCE_BYTES } from '../../../../src/shared/clipboard-image'
import { isKnownRasterImageMimeType } from '../../../../src/shared/file-preview/raster-image-preview-limits'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../../files/attachments/mobile-clipboard-image-upload-chunk'

// The page cannot reach the clipboard, Photos or the share sheet from the WebView, so it hands the image to the shell.
// Images above the frame cap arrive in staged chunks; one verb with an action keeps routes within the grant ceiling.
export const BRIDGE_IMAGE_OPERATIONS = ['copy', 'save', 'share'] as const

export type BridgeImageOperation = (typeof BRIDGE_IMAGE_OPERATIONS)[number]

const byteOffsetSchema = z.number().int().min(0).max(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES)

// Only formats Photos, the clipboard and share targets all accept as images; SVG stays out.
const rasterMimeSchema = z.string().max(128).refine(isKnownRasterImageMimeType)

// Offset 0 starts a new staged image and drops any earlier one; later chunks must continue exactly where the last ended.
const imageStageParamsSchema = z.strictObject({
  action: z.literal('stage'),
  offset: byteOffsetSchema,
  base64: z
    .string()
    .min(1)
    .max(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
})

const imageRunParamsSchema = z.strictObject({
  action: z.literal('run'),
  operation: z.enum(BRIDGE_IMAGE_OPERATIONS),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('staged'),
      mime: rasterMimeSchema,
      byteLength: byteOffsetSchema.min(1)
    }),
    // The page cannot read cross-origin pixels, so the shell downloads web images itself.
    z.strictObject({ kind: z.literal('url'), url: z.url({ protocol: /^https$/ }) })
  ])
})

export const imageParamsSchema = z.discriminatedUnion('action', [
  imageStageParamsSchema,
  imageRunParamsSchema
])

export type BridgeImageRunParams = Omit<z.infer<typeof imageRunParamsSchema>, 'action'>

export const imageResultSchema = z.strictObject({})
