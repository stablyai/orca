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
  constructor(refusal: BridgeRefusal) {
    super(`the reply could not be delivered to the page (${refusal})`)
    this.name = 'BridgeReplyUndeliverableError'
  }
}
