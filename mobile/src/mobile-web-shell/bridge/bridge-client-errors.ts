import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import type { BridgeRefusal } from './bridge-caps'

/** Everything the page's own client raises, as opposed to what it reconstructs from the shell. */

/** A call that needs a session the page is not in yet. Always a mount-order bug, never a retry. */
export class BridgeClientNotReadyError extends Error {
  constructor() {
    super('the page bridge has no session yet; wait for init before calling the client')
    this.name = 'BridgeClientNotReadyError'
  }
}

export class BridgeClientClosedError extends Error {
  constructor() {
    super('the page bridge was closed')
    this.name = 'BridgeClientClosedError'
  }
}

/** A second `init` naming a different session: whatever the page still held belonged to the shell
 *  that is now gone, and the one that replaced it has never heard of any of it. */
export class BridgeShellReplacedError extends Error {
  constructor() {
    super('the shell behind this page was replaced')
    this.name = 'BridgeShellReplacedError'
  }
}

/** The page's copy of the shell's in-flight caps, refusing before the round trip rather than after. */
export class BridgeClientCapExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeClientCapExceededError'
  }
}

/** The shell answered and the page could not read the answer, so the desktop has already run the
 *  request: a caller told this was a definite failure would offer to retry what already happened. */
export class BridgeReplyRefusedError extends Error {
  constructor(refusal: BridgeRefusal) {
    super(`the reply could not be read (${refusal})`)
    this.name = 'BridgeReplyRefusedError'
    markRpcDeliveryUnknown(this)
  }
}

/** The frame never left the page, so this is a definite send failure and carries no delivery mark. */
export class BridgeSendFailedError extends Error {
  constructor() {
    super('the request could not be posted to the shell')
    this.name = 'BridgeSendFailedError'
  }
}

/**
 * A request bigger than one frame may be, refused before it is posted.
 *
 * The shell's reader drops an oversized frame with a diagnostic and answers nothing, so posting it
 * anyway leaves the caller's promise pending for the life of the page — a spinner that never stops
 * and an error surface that is never written to. `git.bulkStage` carrying every changed path is the
 * shape that reaches this on a large enough workspace.
 *
 * The message is what the screen puts on the user's error surface, so it says what to do rather
 * than naming a cap nobody can act on. Also a definite failure: the frame never left, so nothing
 * ran on the desktop and no delivery mark belongs on it.
 */
export class BridgeRequestOversizedError extends Error {
  /** Carried so a caller can switch on this rather than reading it out of the message. */
  readonly code = 'bridge_request_oversized'

  constructor() {
    super('This action sends too much at once to reach Orca. Try it on fewer files.')
    this.name = 'BridgeRequestOversizedError'
  }
}

/** A method sent through the native-verb member that is not one. The member is typed, so this is
 *  reachable only from a caller that widened it; refusing keeps the member from being a raw port. */
export class BridgeClientNotNativeVerbError extends Error {
  /** Named for the page, so this does not fall through to an unknown reason. */
  readonly code = 'native_verb_not_a_verb'

  constructor(method: string) {
    super(`${method} is not a native verb`)
    this.name = 'BridgeClientNotNativeVerbError'
  }
}
