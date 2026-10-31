import { z } from 'zod'
import {
  audioReadParamsSchema,
  audioReadResultSchema,
  audioStartParamsSchema,
  audioStartResultSchema,
  audioStopParamsSchema,
  audioStopResultSchema
} from './bridge-audio-verbs'
import {
  mediaPickParamsSchema,
  mediaPickResultSchema,
  mediaReadParamsSchema,
  mediaReadResultSchema,
  mediaReleaseParamsSchema,
  mediaReleaseResultSchema,
  mediaNameParamsSchema,
  mediaNameResultSchema
} from './bridge-media-verbs'
import { PAGE_STORAGE_MAX_KEY_CHARS } from '../page-storage-keys'
import { mobileFileMediaMime, PDF_MIME_TYPE } from '../../files/mobile-file-media'

// Fence native-prefixed requests on-device; desktop allowlist refusal alone would hide leaked forwarding and depend on desktop version.
// Native replies use existing frames/in-flight caps without runtime _meta; adding a verb needs a table row and handler, never a new frame kind.
export const BRIDGE_NATIVE_METHOD_PREFIX = 'native.'

export const BRIDGE_NATIVE_VERB_NAMES = [
  'native.clipboard.write',
  'native.clipboard.read',
  'native.media.pick',
  'native.media.read',
  'native.media.release',
  'native.media.name',
  'native.audio.start',
  'native.audio.read',
  'native.audio.stop',
  'native.storage.read',
  'native.pdf.view',
  'native.browser.local',
  'native.browser.view'
] as const

export type BridgeNativeVerb = (typeof BRIDGE_NATIVE_VERB_NAMES)[number]

// Verbs the shell grants every page without a manifest declaration: routes are capped at 16 grants, and these only
// open an in-app view of something the page already shows.
export const BRIDGE_IMPLICIT_NATIVE_VERBS = [
  'native.browser.local',
  'native.browser.view'
] as const satisfies readonly BridgeNativeVerb[]

// Keep clipboard reads text-only; images use media.pick and chunked reads instead of exceeding inline reply limits.
export const BRIDGE_CLIPBOARD_MIMES = ['text'] as const

export type BridgeClipboardMime = (typeof BRIDGE_CLIPBOARD_MIMES)[number]

const mimeSchema = z.enum(BRIDGE_CLIPBOARD_MIMES)

// Validate page params and shell results against one contract before dispatch/reply.
export type BridgeNativeVerbSpec = {
  params: z.ZodType
  result: z.ZodType
}

// Let the frame cap bound clipboard writes and the normal reply cap bound reads; a separate text cap would reject values the transport already accepts.
// Export concrete schemas for typed handler parsing; the dispatch table widens them to ZodType.
// Reject extra params so mixed-version builds cannot silently ignore a field the caller relies on.
export const clipboardWriteParamsSchema = z.strictObject({ mime: mimeSchema, value: z.string() })
export const clipboardReadParamsSchema = z.strictObject({ mime: mimeSchema })

export const clipboardWriteResultSchema = z.strictObject({ written: z.boolean() })
export const clipboardReadResultSchema = z.strictObject({ value: z.string() })

export const storageReadParamsSchema = z.strictObject({
  key: z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS)
})
export const storageReadResultSchema = z.strictObject({ value: z.string().nullable() })

// The shell downloads the file itself; page bytes would need staging verbs and exceed the frame cap.
// Bridge requests cannot be cancelled, so a preview the user left sends cancel; one verb keeps routes within the grant ceiling.
export const pdfViewParamsSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    worktreeId: z.string().min(1),
    relativePath: z.string().refine((path) => mobileFileMediaMime(path) === PDF_MIME_TYPE),
    executionHost: z.templateLiteral(['runtime:', z.string().min(1)]).optional()
  }),
  z.strictObject({ action: z.literal('cancel') })
])
export const pdfViewResultSchema = z.strictObject({})

export type BridgePdfOpenParams = Omit<
  Extract<z.infer<typeof pdfViewParamsSchema>, { action: 'open' }>,
  'action'
>

// The shell draws a browser tab in its own web view, with traffic through the host; relayed servers stay streamed.
const browserViewModeSchema = z.enum(['web', 'mobile'])
// Only shells that serve native.browser.view take a layout; older ones refuse params they do not know.
export const browserLocalParamsSchema = z.strictObject({
  worktreeId: z.string().min(1),
  url: z.string().max(8192),
  viewMode: browserViewModeSchema.optional()
})
export const browserLocalResultSchema = z.strictObject({})

export type BridgeBrowserLocalParams = z.infer<typeof browserLocalParamsSchema>

// The pane's place in the page, in the page's CSS pixels; an empty frame keeps the view alive but hidden.
const browserViewFrameSchema = z.strictObject({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  width: z.number().finite().min(0).max(100_000),
  height: z.number().finite().min(0).max(100_000)
})
export type BridgeBrowserViewFrame = z.infer<typeof browserViewFrameSchema>

// The shell draws the tab in a native web view placed over the page's pane. show answers when the view ends,
// so the page learns that the user chose streaming without a shell-to-page message. The id ties move and hide to
// one show: a hide can arrive while its show is still starting.
const browserViewIdSchema = z.string().min(1).max(64)
export const browserViewParamsSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('show'),
    id: browserViewIdSchema,
    worktreeId: z.string().min(1),
    url: z.string().max(8192),
    viewMode: browserViewModeSchema,
    frame: browserViewFrameSchema
  }),
  z.strictObject({
    action: z.literal('move'),
    id: browserViewIdSchema,
    frame: browserViewFrameSchema
  }),
  z.strictObject({ action: z.literal('hide'), id: browserViewIdSchema })
])
// streamed: the user chose streaming; setting: the browser settings stream tabs; replaced: another pane took the
// view; failed: the tunnel through the host failed.
export const BRIDGE_BROWSER_VIEW_ENDINGS = [
  'streamed',
  'setting',
  'replaced',
  'hidden',
  'failed'
] as const
export const browserViewResultSchema = z.strictObject({
  ended: z.enum(BRIDGE_BROWSER_VIEW_ENDINGS).optional()
})

export type BridgeBrowserViewParams = z.infer<typeof browserViewParamsSchema>
export type BridgeBrowserViewShowParams = Omit<
  Extract<BridgeBrowserViewParams, { action: 'show' }>,
  'action'
>
export type BridgeBrowserViewEnding = (typeof BRIDGE_BROWSER_VIEW_ENDINGS)[number]

export const BRIDGE_NATIVE_VERBS: Readonly<Record<BridgeNativeVerb, BridgeNativeVerbSpec>> = {
  'native.clipboard.write': {
    params: clipboardWriteParamsSchema,
    result: clipboardWriteResultSchema
  },
  'native.clipboard.read': {
    params: clipboardReadParamsSchema,
    result: clipboardReadResultSchema
  },
  'native.media.pick': {
    params: mediaPickParamsSchema,
    result: mediaPickResultSchema
  },
  'native.media.read': {
    params: mediaReadParamsSchema,
    result: mediaReadResultSchema
  },
  'native.media.release': {
    params: mediaReleaseParamsSchema,
    result: mediaReleaseResultSchema
  },
  'native.media.name': {
    params: mediaNameParamsSchema,
    result: mediaNameResultSchema
  },
  'native.audio.start': {
    params: audioStartParamsSchema,
    result: audioStartResultSchema
  },
  'native.audio.read': {
    params: audioReadParamsSchema,
    result: audioReadResultSchema
  },
  'native.audio.stop': {
    params: audioStopParamsSchema,
    result: audioStopResultSchema
  },
  'native.storage.read': {
    params: storageReadParamsSchema,
    result: storageReadResultSchema
  },
  'native.pdf.view': {
    params: pdfViewParamsSchema,
    result: pdfViewResultSchema
  },
  'native.browser.local': {
    params: browserLocalParamsSchema,
    result: browserLocalResultSchema
  },
  'native.browser.view': {
    params: browserViewParamsSchema,
    result: browserViewResultSchema
  }
}

export function isBridgeNativeMethod(method: string): boolean {
  return method.startsWith(BRIDGE_NATIVE_METHOD_PREFIX)
}

export function readBridgeNativeVerb(method: string): BridgeNativeVerb | null {
  return BRIDGE_NATIVE_VERB_NAMES.find((verb) => verb === method) ?? null
}

export type BridgeNativeVerbRefusal = 'unknown-verb' | 'ungranted' | 'invalid-params'

export const BRIDGE_NATIVE_VERB_REFUSAL_CODES = {
  'unknown-verb': 'native_verb_unknown',
  ungranted: 'native_verb_ungranted',
  'invalid-params': 'native_verb_params'
} as const

export type BridgeNativeVerbRead =
  | { ok: true; verb: BridgeNativeVerb; params: unknown }
  | { ok: false; refusal: BridgeNativeVerbRefusal; detail: string }

// Resolve method and per-route grant before dispatch; keep refusal reasons explicit for the page.
export function readBridgeNativeVerbCall(args: {
  method: string
  granted: readonly string[]
  params: unknown
}): BridgeNativeVerbRead {
  const verb = readBridgeNativeVerb(args.method)
  if (verb === null) {
    return {
      ok: false,
      refusal: 'unknown-verb',
      detail: `this build serves no verb named ${args.method}`
    }
  }
  if (!args.granted.includes(verb)) {
    return { ok: false, refusal: 'ungranted', detail: `the page was not granted ${verb}` }
  }
  const read = BRIDGE_NATIVE_VERBS[verb].params.safeParse(args.params)
  if (!read.success) {
    return {
      ok: false,
      refusal: 'invalid-params',
      detail: `${verb} was called with params it does not take`
    }
  }
  return { ok: true, verb, params: read.data }
}
