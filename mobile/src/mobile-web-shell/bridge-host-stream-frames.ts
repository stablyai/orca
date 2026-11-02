import { BRIDGE_MAX_SUBSCRIPTIONS } from './bridge/bridge-caps'
import type { BridgeClientMessage } from './bridge/bridge-envelope'
import { isBridgeNativeMethod } from './bridge/bridge-native-verbs'
import { substituteBridgePageClientIdentity } from './bridge/bridge-page-client-identity'
import { bridgeBinaryLaneVerdict } from './bridge/bridge-screencast-grant'
import { BridgeCapExceededError, BridgeNativeVerbRefusedError } from './bridge-host-errors'
import type { BridgeHostDiagnostic } from './bridge-host-contract'
import type { BridgeHostSubscriptions } from './bridge-host-subscriptions'

export type BridgeSubscribeMessage = Extract<BridgeClientMessage, { type: 'subscribe' }>

export type BridgeHostStreamFrames = {
  open: (message: BridgeSubscribeMessage) => void
  cancel: (id: string) => void
  ack: (id: string, seq: number) => void
}

// Keep stream open/cancel/ack rules together; host cancel still chooses between request and stream ids, which share one namespace.
export function createBridgeHostStreamFrames(deps: {
  requests: { has: (id: string) => boolean }
  subscriptions: BridgeHostSubscriptions
  sendError: (id: string, error: unknown) => void
  granted: readonly string[]
  readClientIdentity: () => string | null
  report: (diagnostic: BridgeHostDiagnostic) => void
}): BridgeHostStreamFrames {
  const { requests, subscriptions, sendError, granted, readClientIdentity, report } = deps
  return {
    open: (message) => {
      const { id } = message
      // Collision wins over method refusal; otherwise the fence’s error would settle an unrelated live request.
      if (requests.has(id) || subscriptions.has(id)) {
        sendError(id, new BridgeCapExceededError('that id is already in flight'))
        return
      }
      // Fence native methods on the subscription path before taking a slot or reaching the desktop.
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
        // Resolve identity placeholders on this subscription path too, including terminal.subscribe.
        subscriptions.start(
          id,
          message.method,
          substituteBridgePageClientIdentity(message.params, readClientIdentity()),
          lane === 'serve',
          message.envelope
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
