import { AppState } from 'react-native'
import { readRecords, mutateRecords } from './mobile-push-registration-records'
import {
  registerMobilePushTarget,
  holdHostPushPreparation,
  type HostPushState
} from './mobile-push-host-target'
import { NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import { preparePushConsent } from './push-consent-preparation'
import type { MobilePushOwner } from './mobile-push-token-owner'

type PushClient = RpcOperationSender
const REQUEST_TIMEOUT_MS = 5_000
const NOTIFICATIONS_REMOTE_PUSH_CAPABILITY = NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY
export type HostReconciliationContext = {
  hostsById: Map<string, HostPushState>
  readonly owner: MobilePushOwner | undefined
  readonly consentGeneration: number
  readonly localOperations: number
  enqueueReconcile(hostId: string): void
  sendUnregister(client: PushClient, timeoutMs: number): Promise<boolean>
}

export async function reconcileHost(
  hostId: string,
  context: HostReconciliationContext
): Promise<void> {
  const { hostsById, enqueueReconcile } = context
  const state = hostsById.get(hostId)
  const client = state?.connection.client
  if (!state || !client || context.localOperations > 0) {
    return
  }
  const root = context.owner
  const generation = context.consentGeneration
  const isCurrent = () => hostsById.get(hostId) === state && state.connection.client === client
  const dispatchCurrent = () =>
    context.localOperations === 0 && generation === context.consentGeneration && isCurrent()
  const consentCurrent = () =>
    dispatchCurrent() && context.owner === root && (root === undefined || root.isCurrent())
  const observeConsent = async () => {
    let retired = false
    const valid = () => !retired && consentCurrent()
    const handle = preparePushConsent(valid)
    const finish = holdHostPushPreparation(state, handle, valid, () => {
      retired = true
    })
    try {
      const result = await handle.result
      return retired ? { status: 'retired' as const } : result
    } finally {
      finish()
    }
  }
  const value = await readRecords()
  if (!dispatchCurrent()) {
    return
  }
  // Unregister intent takes priority even before the capability probe answers.
  if (value.pending.has(hostId)) {
    if (state.supported === false || !(await context.sendUnregister(client, REQUEST_TIMEOUT_MS))) {
      return
    }
    if (!dispatchCurrent()) {
      return
    }
    state.target = { root, client, target: 'disabled', acknowledged: true }
    await mutateRecords((current) => {
      if (dispatchCurrent()) {
        current.pending.delete(hostId)
        current.registered.delete(hostId)
      }
    })
    // A preference change can invalidate a register without disabling push.
    if (!dispatchCurrent()) {
      return
    }
    const consent = await observeConsent()
    if (consent.status === 'retired' || !consent.preference.value || !consentCurrent()) {
      return
    }
  }
  if (state.supported == null) {
    if (!dispatchCurrent()) {
      return
    }
    state.capabilityProbeStop ??= startRuntimeCapabilityProbe(client, (capabilities) => {
      if (!isCurrent()) {
        return
      }
      state.supported = capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_CAPABILITY)
      state.connection.support?.complete(state.supported)
      state.routeKeySupported = capabilities.includes('notifications.push-route-key.v1')
      enqueueReconcile(hostId)
    })
    return
  }
  if (!state.supported || !dispatchCurrent()) {
    return
  }
  const consent = await observeConsent()
  if (consent.status === 'retired' || !consentCurrent()) {
    return
  }
  if (!consent.preference.value) {
    if (root && root.isCurrent()) {
      root.acceptHostConsent(false)
    }
    // Saved consent recovers a disable even if its pending-record write failed.
    if (
      state.target?.client !== client ||
      state.target.target !== 'disabled' ||
      !state.target.acknowledged
    ) {
      if (!(await context.sendUnregister(client, REQUEST_TIMEOUT_MS)) || !dispatchCurrent()) {
        return
      }
      state.target = { root, client, target: 'disabled', acknowledged: true }
    }
    await mutateRecords((current) => {
      if (dispatchCurrent()) {
        current.pending.delete(hostId)
        current.registered.delete(hostId)
      }
    })
    return
  }
  if (!root || !root.isCurrent() || AppState.currentState !== 'active') {
    return
  }
  const result = await registerMobilePushTarget(root, state, client, generation, isCurrent)
  if (
    result === 'stale' &&
    isCurrent() &&
    (generation !== context.consentGeneration || context.owner === undefined)
  ) {
    await mutateRecords((current) => {
      if (isCurrent()) {
        current.pending.add(hostId)
      }
    })
    state.dirty = true
  } else if (result === true && dispatchCurrent()) {
    await mutateRecords((current) => {
      if (context.owner === root && root.isCurrent() && dispatchCurrent()) {
        current.registered.add(hostId)
      }
    })
  }
}
