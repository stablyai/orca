import type { RelayDispatcher, RequestContext } from './dispatcher'
import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import {
  parsePtyOwnershipTransferDestinationReplayRequest,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD
} from '../shared/pty-ownership-transfer-destination-claim'
import {
  requireDestinationProof,
  readRelayPtyOwnershipTransferDestinationReplay,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'
import { RelayPtyOwnershipTransferDestinationOutputRoute } from './relay-pty-ownership-transfer-destination-output-route'
import { RELAY_PTY_DESTINATION_EXECUTION_NOTIFICATION } from '../shared/pty-ownership-transfer-execution-notification'

export function registerRelayPtyDestinationOutputSubscriptions(
  state: RelayPtyOwnershipTransferAdapterState,
  dispatcher: RelayDispatcher
): void {
  if (
    !state.options.enableDestinationOutputRoutes ||
    !state.options.enableDestinationOutputRetention ||
    !state.options.enableDestinationDelegationClaims
  ) {
    return
  }
  const subscriptions = new Map<
    string,
    {
      transfer: RelayPtyOwnershipTransferRecord
      route: RelayPtyOwnershipTransferDestinationOutputRoute
      cursor: number
      context: RequestContext
      active: () => boolean
      executionNotifications: boolean
      executionNotified: boolean
    }
  >()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const removeSubscription = (id: string) => {
    const subscription = subscriptions.get(id)
    if (!subscription) {
      return
    }
    subscription.route.dispose()
    subscriptions.delete(id)
    if (subscription.transfer.destinationOutputRoute === subscription.route) {
      subscription.transfer.destinationOutputRoute = undefined
    }
  }
  const wake = () => {
    if (!disposed && !timer && subscriptions.size > 0) {
      timer = setTimeout(pump, 0)
    }
  }
  const pump = () => {
    timer = undefined
    if (disposed) {
      return
    }
    let remaining = 32
    for (const [id, subscription] of subscriptions) {
      if (!subscription.active()) {
        removeSubscription(id)
        continue
      }
      const history = state.histories.get(subscription.transfer.identity.terminalId)
      for (const frame of history?.frames ?? []) {
        if (frame.seq <= subscription.cursor) {
          continue
        }
        if (remaining-- <= 0) {
          wake()
          return
        }
        // Producer rejection/throw leaves the journal and exact unsent frame intact.
        try {
          if (!subscription.route.publish(frame)) {
            break
          }
        } catch {
          break
        }
        subscription.cursor = frame.seq
        subscription.transfer.destinationDeliveredSeq = frame.seq
      }
      const transfer = subscription.transfer
      if (
        subscription.executionNotifications &&
        !subscription.executionNotified &&
        transfer.exit &&
        !transfer.exitObservationPending &&
        subscription.cursor === transfer.sourceOutputEndSeq &&
        subscription.active()
      ) {
        if (remaining-- <= 0) {
          wake()
          return
        }
        try {
          subscription.executionNotified = dispatcher.publishProducerNotification(
            subscription.context.clientId,
            RELAY_PTY_DESTINATION_EXECUTION_NOTIFICATION,
            {
              ...transfer.identity,
              version: 1,
              destinationClaim: transfer.destinationClaim,
              finalOutputSeq: transfer.sourceOutputEndSeq
            },
            { logDrop: false }
          )
        } catch {
          // Retry on existing transport capacity or reconnect, never infer delivery from a throw.
        }
      }
    }
  }
  state.wakeDestinationOutput = wake
  const removeCapacityListener = dispatcher.onLegacyPtyCapacity(wake)
  const removeDetachListener = dispatcher.onClientDetached((clientId) => {
    for (const [id, subscription] of subscriptions) {
      if (subscription.context.clientId !== clientId) {
        continue
      }
      removeSubscription(id)
    }
    if (subscriptions.size === 0 && timer) {
      clearTimeout(timer)
      timer = undefined
    }
  })
  const removeDisposeListener = dispatcher.onDisposed(() => {
    disposed = true
    if (timer) {
      clearTimeout(timer)
    }
    timer = undefined
    for (const id of subscriptions.keys()) {
      removeSubscription(id)
    }
    removeCapacityListener()
    removeDetachListener()
    removeDisposeListener()
    if (state.wakeDestinationOutput === wake) {
      state.wakeDestinationOutput = undefined
    }
  })
  dispatcher.onRequest(
    PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD,
    async (value, context) => {
      if (disposed) {
        throw new Error('pty_ownership_transfer_destination_output_subscription_unavailable')
      }
      const request = parsePtyOwnershipTransferDestinationReplayRequest(value)
      const executionNotifications = value.executionNotifications === 1
      const { transfer } = requireDestinationProof(state, request, context)
      const active = () =>
        isRelayPtyOwnershipTransferDestinationClaimActive(
          state,
          request,
          request.destinationClaim,
          context
        )
      if (!transfer.destinationOutputRetention || !active()) {
        throw new Error('pty_ownership_transfer_destination_output_subscription_unavailable')
      }
      // A new stream cannot silently skip a retained prefix that has no durable destination ACK.
      if (request.afterSeq !== transfer.destinationAcknowledgedSeq) {
        throw new Error('pty_ownership_transfer_destination_output_subscription_cursor_invalid')
      }
      readRelayPtyOwnershipTransferDestinationReplay(state, request, context)
      transfer.destinationOutputRoute?.dispose()
      const route = new RelayPtyOwnershipTransferDestinationOutputRoute({
        dispatcher,
        clientId: context.clientId,
        identity: transfer.identity,
        claim: request.destinationClaim,
        isActive: active,
        windowBytes: Math.min(state.replayBytes, 512 * 1024)
      })
      transfer.destinationOutputRoute = route
      transfer.destinationDeliveredSeq = request.afterSeq
      subscriptions.set(request.bridgeId, {
        transfer,
        route,
        cursor: request.afterSeq,
        context,
        active,
        executionNotifications,
        executionNotified: false
      })
      wake()
      return {
        ...transfer.identity,
        version: 1,
        afterSeq: request.afterSeq,
        subscribed: true,
        ...(executionNotifications ? { executionNotifications: 1 } : {})
      }
    }
  )
}
