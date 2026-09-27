import { BRIDGE_MAX_SUBSCRIPTIONS } from './bridge/bridge-caps'
import type { BridgeClientMessage } from './bridge/bridge-envelope'
import { isBridgeNativeMethod } from './bridge/bridge-native-verbs'
import { substituteBridgePageClientIdentity } from './bridge/bridge-page-client-identity'
import { bridgeBinaryLaneVerdict } from './bridge/bridge-screencast-grant'
import { BridgeCapExceededError, BridgeNativeVerbRefusedError } from './bridge-host-errors'
import type { BridgeHostDiagnostic } from './bridge-host-contract'
import type { BridgeHostSubscriptions } from './bridge-host-subscriptions'

export type BridgeSubscribeMessage = Extract<BridgeClientMessage, { type: 'subscribe' }>

/** What the page's three stream frames do, so the host's dispatch reads as the routing it is. */
export type BridgeHostStreamFrames = {
  open: (message: BridgeSubscribeMessage) => void
  cancel: (id: string) => void
  ack: (id: string, seq: number) => void
}

/**
 * The rules that turn a page's stream frames into ledger operations.
 *
 * Split out of `bridge-host.ts` when opening a stream grew a fourth rule: that file is the host's
 * lifecycle and its dispatch, and this is the only frame kind whose handling is more than one line
 * of delegation. `cancel` and `ack` come with it so all three stream frames are decided in one
 * place, and the host's `cancel` arm still chooses between a stream and a request where it always
 * did — a page's `cancel` names one or the other and splitting that choice would put half an arm
 * in each module.
 *
 * `requests` is narrowed to the one question asked of it: an id already in flight as a request is
 * not available to a stream.
 */
export function createBridgeHostStreamFrames(deps: {
  requests: { has: (id: string) => boolean }
  subscriptions: BridgeHostSubscriptions
  sendError: (id: string, error: unknown) => void
  /** The session's resolved grants, which decide whether the binary screencast lane is served. */
  granted: readonly string[]
  /** This device's identity to the host, swapped in for the page's placeholder. */
  readClientIdentity: () => string | null
  report: (diagnostic: BridgeHostDiagnostic) => void
}): BridgeHostStreamFrames {
  const { requests, subscriptions, sendError, granted, readClientIdentity, report } = deps
  return {
    open: (message) => {
      const { id } = message
      // Collision first: both refusals settle the same exchange, and an id already in flight is the
      // truer cause — answering the fence there would kill a live request while naming the method.
      if (requests.has(id) || subscriptions.has(id)) {
        sendError(id, new BridgeCapExceededError('that id is already in flight'))
        return
      }
      // The fence is about the method name, not the frame kind: a `native.` verb is answered here or
      // not at all, and a stream is another door to the same client. Still before any slot is taken,
      // so nothing about this frame reaches the desktop.
      if (isBridgeNativeMethod(message.method)) {
        sendError(
          id,
          new BridgeNativeVerbRefusedError(
            'native_verb_not_a_stream',
            `${message.method} is not a stream this shell serves`
          )
        )
        return
      }
      if (subscriptions.size >= BRIDGE_MAX_SUBSCRIPTIONS) {
        sendError(id, new BridgeCapExceededError(`over ${BRIDGE_MAX_SUBSCRIPTIONS} subscriptions`))
        return
      }
      const lane = bridgeBinaryLaneVerdict({ wantsBinary: message.wantsBinary, granted })
      if (lane === 'ungranted') {
        report({ kind: 'binary-lane-refused', id })
      }
      try {
        // The other door, which is the one `terminal.subscribe` goes through. A placeholder the
        // shell cannot resolve throws here and is refused the way an ungranted method is.
        subscriptions.start(
          id,
          message.method,
          substituteBridgePageClientIdentity(message.params, readClientIdentity()),
          lane === 'serve'
        )
      } catch (error) {
        sendError(id, error)
      }
    },
    cancel: (id) => {
      subscriptions.cancel(id, 'unsubscribed')
    },
    ack: (id, seq) => {
      subscriptions.ack(id, seq)
    }
  }
}
