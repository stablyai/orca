import type { BridgeRefusal } from './bridge/bridge-caps'

/** Everything the RN host raises on its own, as opposed to what it forwards from the client. */

/** The bridge went away with a request still on it. Carried to the page as delivery-unknown: the
 *  desktop may already have run it. */
export class BridgeHostDisposedError extends Error {
  constructor() {
    super('the page bridge was torn down before this request answered')
    this.name = 'BridgeHostDisposedError'
  }
}

/** A page over a cap `init` already told it. Refusing the newcomer leaves what it collided with. */
export class BridgeCapExceededError extends Error {
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
export const BRIDGE_NATIVE_REFUSAL_CODE = 'native_verb_refused'

export class BridgeNativeVerbRefusedError extends Error {
  readonly code = BRIDGE_NATIVE_REFUSAL_CODE

  constructor(message: string) {
    super(message)
    this.name = 'BridgeNativeVerbRefusedError'
  }
}
