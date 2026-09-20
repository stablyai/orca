import { z } from 'zod'
import {
  mediaPickParamsSchema,
  mediaPickResultSchema,
  mediaReadParamsSchema,
  mediaReadResultSchema,
  mediaReleaseParamsSchema,
  mediaReleaseResultSchema
} from './bridge-media-verbs'

/**
 * The shell-answered request seam: what a `native.` method is, and every verb there is.
 *
 * A page `request` whose method starts with this prefix is answered by the host and never reaches
 * the desktop. That fence is the load-bearing one. The desktop would refuse the method too — it is
 * absent from `MOBILE_RPC_METHOD_ALLOWLIST`, which answers `forbidden` for anything unlisted — but
 * that only applies to a request that got as far as a paired desktop, and depends on its version.
 * The point of the prefix is that the request never leaves the phone, so neither matters.
 *
 * Replies ride the existing `reply` and `error` frames and count against the same in-flight cap as
 * a forwarded request. They carry **no `_meta`**: `isRpcResponse` does not require it on either
 * arm, and no runtime produced these, so a page reader must not depend on one being there.
 *
 * Adding a verb is a row here plus a handler; it is never a new frame kind.
 */
export const BRIDGE_NATIVE_METHOD_PREFIX = 'native.'

/** Every verb this shell serves. The table below must cover exactly these, or it does not compile. */
export const BRIDGE_NATIVE_VERB_NAMES = [
  'native.clipboard.write',
  'native.clipboard.read',
  'native.media.pick',
  'native.media.read',
  'native.media.release'
] as const

export type BridgeNativeVerb = (typeof BRIDGE_NATIVE_VERB_NAMES)[number]

/**
 * Text, and only text: an image on the pasteboard is `native.media.pick { source: 'clipboard' }`.
 *
 * The shape was broad on first addition so a later build could serve an image without a contract
 * change. That build is the media verbs, and it does not serve one the way this verb would have
 * had to — inline, against a 24 MiB base64 ceiling and an 8 MiB reply cap — so the image arm is
 * retired here rather than left standing as a refusal pointing at nothing.
 */
export const BRIDGE_CLIPBOARD_MIMES = ['text'] as const

export type BridgeClipboardMime = (typeof BRIDGE_CLIPBOARD_MIMES)[number]

const mimeSchema = z.enum(BRIDGE_CLIPBOARD_MIMES)

/**
 * One verb's wire contract. Params are read from the page and are attacker-shaped; results are the
 * shell's own and are declared so a handler cannot answer a shape the page will not parse.
 */
export type BridgeNativeVerbSpec = {
  params: z.ZodType
  result: z.ZodType
}

/**
 * No cap on the written text beyond the frame's own: a clipboard write is bounded by
 * `BRIDGE_MAX_MESSAGE_BYTES` like every other page frame, and a second bound here would refuse
 * what the transport already accepted. The read is bounded on the way out instead, by the reply
 * byte cap every forwarded reply gets.
 */
/** Exported concretely as well as through the table: a handler parses with the schema for the verb
 *  it is serving, so what it holds is typed without an assertion. The table's values are widened to
 *  `ZodType`, which is all the host needs to refuse params before it dispatches. */
// Strict, not stripping: `z.object` drops a key it does not know, so a call carrying one it thinks
// is meaningful would dispatch as if it had not. The page and the shell are separate builds, and a
// param the shell silently ignores is the shape of a verb that changed under a page.
export const clipboardWriteParamsSchema = z.strictObject({ mime: mimeSchema, value: z.string() })
export const clipboardReadParamsSchema = z.strictObject({ mime: mimeSchema })

export const clipboardWriteResultSchema = z.strictObject({ written: z.boolean() })
export const clipboardReadResultSchema = z.strictObject({ value: z.string() })

export const BRIDGE_NATIVE_VERBS: Readonly<Record<BridgeNativeVerb, BridgeNativeVerbSpec>> = {
  'native.clipboard.write': {
    params: clipboardWriteParamsSchema,
    result: clipboardWriteResultSchema
  },
  'native.clipboard.read': {
    params: clipboardReadParamsSchema,
    result: clipboardReadResultSchema
  },
  // The staged-handle trio. Their shapes live beside each other in `bridge-media-verbs.ts`: the
  // three are one contract, and a handle is meaningless without the verb that minted it.
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
  }
}

/** Whether a method the page named is one this seam answers rather than one the desktop serves. */
export function isBridgeNativeMethod(method: string): boolean {
  return method.startsWith(BRIDGE_NATIVE_METHOD_PREFIX)
}

/** The verb a `native.` method names, or null when this shell has no row for it. */
export function readBridgeNativeVerb(method: string): BridgeNativeVerb | null {
  return BRIDGE_NATIVE_VERB_NAMES.find((verb) => verb === method) ?? null
}

/** Why the seam would not serve a `native.` method. Each is a different fault, so each is named. */
export type BridgeNativeVerbRefusal = 'unknown-verb' | 'ungranted' | 'invalid-params'

/** The code each pre-dispatch refusal crosses under. One decision, one name, in one place. */
export const BRIDGE_NATIVE_VERB_REFUSAL_CODES = {
  'unknown-verb': 'native_verb_unknown',
  ungranted: 'native_verb_ungranted',
  'invalid-params': 'native_verb_params'
} as const

export type BridgeNativeVerbRead =
  | { ok: true; verb: BridgeNativeVerb; params: unknown }
  | { ok: false; refusal: BridgeNativeVerbRefusal; detail: string }

/**
 * The whole decision, as a function of what the page asked and what it was granted.
 *
 * Separate from the host so the `ungranted` arm can be exercised at all: every page is offered
 * every verb this build implements, so through a real host that arm is unreachable today, and it
 * is the whole point of the check the moment a grant is per-route.
 */
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
