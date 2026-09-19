import { z } from 'zod'

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
export const BRIDGE_NATIVE_VERB_NAMES = ['native.clipboard.write', 'native.clipboard.read'] as const

export type BridgeNativeVerb = (typeof BRIDGE_NATIVE_VERB_NAMES)[number]

/**
 * Broad on first addition, per the plan's rule: the shape admits an image because a later build
 * will serve one, not because this one does. `image` is refused by name, and the reason says the
 * verb is out of scope here rather than unavailable — `expo-clipboard` implements
 * `getImageAsync`/`setImageAsync`, so a reason claiming the platform cannot would mislead whoever
 * adds it.
 */
export const BRIDGE_CLIPBOARD_MIMES = ['text', 'image'] as const

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
export const BRIDGE_NATIVE_VERBS: Readonly<Record<BridgeNativeVerb, BridgeNativeVerbSpec>> = {
  'native.clipboard.write': {
    params: z.object({ mime: mimeSchema, value: z.string() }),
    result: z.object({ written: z.boolean() })
  },
  'native.clipboard.read': {
    params: z.object({ mime: mimeSchema }),
    result: z.object({ value: z.string() })
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
