import { z } from 'zod'
import type { BridgeRefusal } from './bridge/bridge-caps'

// Use delivery-unknown: the desktop may already have executed an in-flight request before bridge disposal.
export class BridgeHostDisposedError extends Error {
  readonly code = 'bridge_host_disposed'

  constructor() {
    super('the page bridge was torn down before this request answered')
    this.name = 'BridgeHostDisposedError'
  }
}

// Refuse only the newcomer at init-advertised caps; preserve the operation it collided with.
export class BridgeCapExceededError extends Error {
  readonly code = 'bridge_cap_exceeded'

  constructor(message: string) {
    super(message)
    this.name = 'BridgeCapExceededError'
  }
}

// Refuse before sending an unreadable reply so the page receives a named failure.
export class BridgeReplyUndeliverableError extends Error {
  readonly code: BridgeRefusal

  constructor(refusal: BridgeRefusal) {
    super(`the reply could not be delivered to the page (${refusal})`)
    this.name = 'BridgeReplyUndeliverableError'
    this.code = refusal
  }
}

// Keep native refusal codes distinct from desktop forbidden; a leaked native request reaching the desktop must not look like an ordinary grant refusal.
export const BRIDGE_NATIVE_REFUSAL_CODES = [
  'native_verb_unknown',
  'native_verb_ungranted',
  'native_verb_params',
  'native_verb_result',
  // Retain this retired result refusal for older shells, even though no current verb raises it.
  'native_verb_out_of_scope',
  'native_verb_failed',
  // Use one code for never-minted, released and expired handles; their history may belong to another page.
  'native_media_handle_unknown',
  'native_media_range',
  'native_media_handle_cap',
  // Keep oversized picks distinct from unreadable items so the page can offer the appropriate recovery.
  'native_media_too_large',
  // Retain permission denial for future sources; current expo-image-picker 55.0.24 library/Files pickers require no permission.
  'native_media_permission_denied',
  'native_verb_not_a_stream',
  // A missing capture means dictation ended, whether never started, stopped or disposed with its page.
  'native_audio_not_capturing'
] as const

export type BridgeNativeRefusalCode = (typeof BRIDGE_NATIVE_REFUSAL_CODES)[number]

// Native codes are the contract; messages are not. Keep them distinct from desktop forbidden so leaked forwarding cannot masquerade as a scope refusal.
export class BridgeNativeVerbRefusedError extends Error {
  readonly code: BridgeNativeRefusalCode

  constructor(code: BridgeNativeRefusalCode, message: string) {
    super(message)
    this.name = 'BridgeNativeVerbRefusedError'
    this.code = code
  }
}

// Validate arbitrary thrown values before exposing a recognized handler code.
const shellRefusalSchema = z.object({ code: z.enum(BRIDGE_NATIVE_REFUSAL_CODES) })

export function readShellRefusalCode(error: unknown): BridgeNativeRefusalCode | null {
  const read = shellRefusalSchema.safeParse(error)
  return read.success ? read.data.code : null
}
