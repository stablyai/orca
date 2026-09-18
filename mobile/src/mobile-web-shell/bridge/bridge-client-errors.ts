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

export class BridgeReplyRefusedError extends Error {
  constructor(refusal: BridgeRefusal) {
    super(`the reply could not be read (${refusal})`)
    this.name = 'BridgeReplyRefusedError'
  }
}

/** The frame never left the page, so this is a definite send failure and carries no delivery mark. */
export class BridgeSendFailedError extends Error {
  constructor() {
    super('the request could not be posted to the shell')
    this.name = 'BridgeSendFailedError'
  }
}
