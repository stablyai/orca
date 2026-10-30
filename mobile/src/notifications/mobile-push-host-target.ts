import { AppState } from 'react-native'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { MobilePushOwner } from './mobile-push-token-owner'
import type { MobilePushToken } from './push-token'
import { mobilePushRouteKey } from './push-route-declaration'
import {
  loadNotificationDeliveryPreferences,
  notificationPreferencesFilter
} from './notification-delivery-preferences'
import { sendRegister } from './mobile-push-registration-operations'

export type HostPushState = {
  connection: { client: RpcOperationSender | null }
  // An unanswered probe is unknown, not unsupported.
  supported: boolean | null
  routeKeySupported?: boolean
  capabilityProbeStop: (() => void) | null
  chain: Promise<void>
  preparation?: { releaseIfObsolete(): void }
  running?: boolean
  dirty?: boolean
  target?: {
    root: MobilePushOwner | undefined
    client: RpcOperationSender
    target: string
    acknowledged: boolean
  }
}

export function holdHostPushPreparation(
  state: HostPushState,
  handle: { release(): void },
  valid: () => boolean,
  retired: () => void
): () => void {
  const finish = () => {
    handle.release()
    if (state.preparation === preparation) {
      state.preparation = undefined
    }
  }
  const preparation = {
    releaseIfObsolete() {
      if (!valid()) {
        retired()
        finish()
      }
    }
  }
  state.preparation = preparation
  preparation.releaseIfObsolete()
  return finish
}

export async function registerMobilePushTarget(
  root: MobilePushOwner,
  state: HostPushState,
  client: RpcOperationSender,
  generation: number,
  isCurrent: () => boolean
): Promise<true | 'stale' | undefined> {
  if (!root.isCurrent() || !isCurrent()) {
    return
  }
  root.acceptHostConsent(true)
  const renewal = root.renewal
  const capable = state.routeKeySupported
  let released = false
  const tokenCurrent = () =>
    !released &&
    root.isCurrent() &&
    isCurrent() &&
    root.intent === generation &&
    root.enabled === true &&
    root.renewal === renewal &&
    state.supported === true &&
    capable === state.routeKeySupported &&
    AppState.currentState === 'active'
  const handle = root.prepareCurrentToken(tokenCurrent)
  const finishToken = holdHostPushPreparation(state, handle, tokenCurrent, () => {
    released = true
  })
  let token: MobilePushToken | undefined
  try {
    const result = await handle.result
    if (result.status !== 'ready') {
      return
    }
    token = result.token
  } finally {
    finishToken()
  }
  const valid = () => tokenCurrent() && JSON.stringify(root.token) === JSON.stringify(token)
  if (!token || !valid()) {
    return
  }
  const filter = notificationPreferencesFilter(await loadNotificationDeliveryPreferences())
  if (!valid()) {
    return
  }
  let routeKey: string | undefined
  if (capable) {
    const handle = mobilePushRouteKey(valid)
    const finishKey = holdHostPushPreparation(state, handle, valid, () => {
      released = true
    })
    try {
      const result = await handle.result
      if (result.status === 'retired') {
        return
      }
      routeKey = result.status === 'ready' ? result.routeKey : undefined
    } finally {
      finishKey()
    }
  }
  if (!valid() || capable !== state.routeKeySupported) {
    return
  }
  const params = { ...token, filter, ...(routeKey ? { routeKey } : {}) }
  const target = JSON.stringify([generation, root.renewal, true, params, capable])
  const acknowledged = state.target
  if (
    acknowledged?.root === root &&
    acknowledged.client === client &&
    acknowledged.target === target
  ) {
    return
  }
  const attempt = { root, client, target, acknowledged: false }
  state.target = attempt
  const observation = await sendRegister(client, params)
  if (observation.status !== 'registered' || !isCurrent()) {
    return
  }
  if (!valid()) {
    return 'stale'
  }
  attempt.acknowledged = true
  if (routeKey) {
    root.publication.registered(observation.gatewayOrigin)
  }
  return true
}
