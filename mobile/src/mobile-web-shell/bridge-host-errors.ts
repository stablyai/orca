import { z } from 'zod'
import type { BridgeRefusal } from './bridge/bridge-caps'

/** Everything the RN host raises on its own, as opposed to what it forwards from the client. */

/** The bridge went away with a request still on it. Carried to the page as delivery-unknown: the
 *  desktop may already have run it. */
export class BridgeHostDisposedError extends Error {
  /** Carried so the page names this rather than falling through to an unknown reason. */
  readonly code = 'bridge_host_disposed'

  constructor() {
    super('the page bridge was torn down before this request answered')
    this.name = 'BridgeHostDisposedError'
  }
}

/** A page over a cap `init` already told it. Refusing the newcomer leaves what it collided with. */
export class BridgeCapExceededError extends Error {
  readonly code = 'bridge_cap_exceeded'

  constructor(message: string) {
    super(message)
    this.name = 'BridgeCapExceededError'
  }
}

/** A reply the page's own reader would refuse, failed on the sending side so the page hears why. */
export class BridgeReplyUndeliverableError extends Error {
  /** Carried so a page switches on the refusal rather than reading it out of the message. */
  readonly code: BridgeRefusal

  constructor(refusal: BridgeRefusal) {
    super(`the reply could not be delivered to the page (${refusal})`)
    this.name = 'BridgeReplyUndeliverableError'
    this.code = refusal
  }
}

/**
 * A `native.` verb the shell will not serve, in the one vocabulary the desktop does not share.
 *
 * Distinct from the desktop's `forbidden`, which `MOBILE_RPC_METHOD_ALLOWLIST` answers for any
 * method it does not list: a `native.` request that ever reached a desktop would come back under
 * that code, so reusing it would make a leaked fence read as an ordinary scope refusal.
 */
export const BRIDGE_NATIVE_REFUSAL_CODES = [
  /** No row in the verb table for the method the page named. */
  'native_verb_unknown',
  /** A verb this page was not granted. */
  'native_verb_ungranted',
  /** Params the verb does not take. */
  'native_verb_params',
  /** A result the verb does not declare, refused before it reaches the page. */
  'native_verb_result',
  /** A shape the table admits and the shell does not serve. No verb in this build raises it — the
   *  image mime that did is retired into `native.media.pick` — and it stays in the vocabulary
   *  because a shell older than the page still answers with it. */
  'native_verb_out_of_scope',
  /** The handler failed on this device. Its own message stays here; only the code crosses. */
  'native_verb_failed',
  /** A staged media handle this session does not hold: never minted, released, or swept by the
   *  TTL. One code for all three, because which it was is a fact about another page's pick. */
  'native_media_handle_unknown',
  /** A chunk read starting at or past the end of a staged item that had bytes. */
  'native_media_range',
  /** A pick that would leave this session holding more staged items than it may. */
  'native_media_handle_cap',
  /** A picked item over what this shell stages. Its own code because a page showing "too large"
   *  and one showing "could not read that" send the user to different places. */
  'native_media_too_large',
  /** A source whose OS permission was denied, which the user can still grant in Settings. No
   *  source in this build asks for one — the library and Files pickers gate on nothing in
   *  expo-image-picker 55.0.24 — and it is kept for the first that does. */
  'native_media_permission_denied',
  /** A `native.` method on a `subscribe`, which this seam answers on requests only. */
  'native_verb_not_a_stream',
  /** A read or a wake-tag call for a capture this session does not have: never started, stopped,
   *  or ended with the page that asked for it. One code for all three, because the page's answer
   *  to each is the same — its capture is over and its dictation with it. */
  'native_audio_not_capturing'
] as const

export type BridgeNativeRefusalCode = (typeof BRIDGE_NATIVE_REFUSAL_CODES)[number]

/**
 * A `native.` verb the shell will not serve, in a vocabulary the desktop does not share.
 *
 * Every arm has its own code because the message is not a contract: a page deciding what to do
 * about an out-of-scope mime and one whose clipboard could not be read want different things, and
 * telling them apart by message text is how that decision rots.
 *
 * None of these collide with the desktop's `forbidden`, which `MOBILE_RPC_METHOD_ALLOWLIST`
 * answers for an unlisted method, so a leaked fence can never read as a scope refusal.
 */
export class BridgeNativeVerbRefusedError extends Error {
  readonly code: BridgeNativeRefusalCode

  constructor(code: BridgeNativeRefusalCode, message: string) {
    super(message)
    this.name = 'BridgeNativeVerbRefusedError'
    this.code = code
  }
}

/**
 * The code a shell-side handler set on its own failure, if it set one this seam knows.
 *
 * Parsed rather than reached for: the value is whatever a handler threw, and the anti-slop rule is
 * the same one the page's reader follows — name the shape before reading it.
 */
const shellRefusalSchema = z.object({ code: z.enum(BRIDGE_NATIVE_REFUSAL_CODES) })

export function readShellRefusalCode(error: unknown): BridgeNativeRefusalCode | null {
  const read = shellRefusalSchema.safeParse(error)
  return read.success ? read.data.code : null
}
