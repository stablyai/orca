import * as z from 'zod'
import { BRIDGE_MEDIA_MAX_LIVE_HANDLES, mediaItemSchema } from './bridge-media-verbs'

// The shell draws the Add context sheet itself, recent photos included, and answers only what the user tapped there.
// The page never sees the photo library: no ids, no thumbnails, only staged handles for the photos chosen in the sheet.
export const BRIDGE_ADD_CONTEXT_VERB = 'native.context.open'

export const BRIDGE_ADD_CONTEXT_CHOICES = [
  'dismissed',
  'recent',
  'camera',
  'photos',
  'files',
  'workspaceFile',
  'skills',
  'commands'
] as const

export type BridgeAddContextChoice = (typeof BRIDGE_ADD_CONTEXT_CHOICES)[number]

// What the page's composer offers; the shell hides the rest.
export const addContextParamsSchema = z.strictObject({
  images: z.boolean(),
  files: z.boolean(),
  structured: z.boolean(),
  skillCount: z.number().int().min(0).max(100_000)
})

export type BridgeAddContextOptions = z.infer<typeof addContextParamsSchema>

// Items are non-empty only for recent, read with native.media.read like any pick; every other choice is the page's to act on.
export const addContextResultSchema = z.strictObject({
  choice: z.enum(BRIDGE_ADD_CONTEXT_CHOICES),
  items: z.array(mediaItemSchema).max(BRIDGE_MEDIA_MAX_LIVE_HANDLES)
})

export type BridgeAddContextResult = z.infer<typeof addContextResultSchema>
