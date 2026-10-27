import { markRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import type { BridgeRefusal } from './bridge-caps'

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

// A different-session init invalidates all exchanges held for the replaced shell.
export class BridgeShellReplacedError extends Error {
  constructor() {
    super('the shell behind this page was replaced')
    this.name = 'BridgeShellReplacedError'
  }
}

export class BridgeClientCapExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeClientCapExceededError'
  }
}

// Unreadable replies are delivery-unknown: desktop execution already happened, so definite failure would invite replay.
export class BridgeReplyRefusedError extends Error {
  constructor(refusal: BridgeRefusal) {
    super(`the reply could not be read (${refusal})`)
    this.name = 'BridgeReplyRefusedError'
    markRpcDeliveryUnknown(this)
  }
}

export class BridgeSendFailedError extends Error {
  constructor() {
    super('the request could not be posted to the shell')
    this.name = 'BridgeSendFailedError'
  }
}

// Refuse oversized requests before posting; the shell drops them without reply and would strand the caller. Nothing was sent, so carry no delivery-unknown mark.
export class BridgeRequestOversizedError extends Error {
  readonly code = 'bridge_request_oversized'

  constructor() {
    super('This action sends too much at once to reach Orca. Try it on fewer files.')
    this.name = 'BridgeRequestOversizedError'
  }
}

// Reject nonnative names even if a widened caller bypasses the typed verb surface; this member must not become a raw RPC port.
export class BridgeClientNotNativeVerbError extends Error {
  readonly code = 'native_verb_not_a_verb'

  constructor(method: string) {
    super(`${method} is not a native verb`)
    this.name = 'BridgeClientNotNativeVerbError'
  }
}

// Refuse unsupported rpcEnvelope fields rather than executing without the caller’s required wire metadata.
export class BridgeRpcEnvelopeUngrantedError extends Error {
  readonly code = 'bridge_rpc_envelope_ungranted'

  constructor() {
    super('this app version cannot send extra request fields; update the Orca app')
    this.name = 'BridgeRpcEnvelopeUngrantedError'
  }
}

export class BridgeRpcEnvelopeInvalidError extends Error {
  readonly code = 'bridge_rpc_envelope_invalid'

  constructor() {
    super('extra request fields must be a plain JSON object')
    this.name = 'BridgeRpcEnvelopeInvalidError'
  }
}
