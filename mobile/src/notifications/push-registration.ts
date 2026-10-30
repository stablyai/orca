import { mutateRecords, resetRegistrationRecords } from './mobile-push-registration-records'
import type { HostPushState } from './mobile-push-host-target'
import {
  saveNotificationDeliveryPreferences,
  type NotificationDeliveryPreferences
} from './notification-delivery-preferences'
import { NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { savePushNotificationsEnabled } from '../storage/preferences'
import { createMobilePushOwner, type MobilePushOwner } from './mobile-push-token-owner'
import { pushRouteUnregister } from './mobile-push-registration-operations'

import { reconcileHost, type HostReconciliationContext } from './mobile-push-host-reconciliation'

export const NOTIFICATIONS_REMOTE_PUSH_CAPABILITY = NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY

type PushClient = RpcOperationSender

const REMOVAL_TIMEOUT_MS = 2_000

const hostsById = new Map<string, HostPushState>()
let owner: MobilePushOwner | undefined
// A late registration must not overwrite a newer preference or consent choice.
let consentGeneration = 0
let localOperations = 0
const reconciliation: HostReconciliationContext = {
  hostsById,
  get owner() {
    return owner
  },
  get consentGeneration() {
    return consentGeneration
  },
  get localOperations() {
    return localOperations
  },
  enqueueReconcile,
  sendUnregister
}

function hostState(hostId: string): HostPushState {
  let state = hostsById.get(hostId)
  if (!state) {
    state = {
      connection: { client: null },
      supported: null,
      capabilityProbeStop: null,
      chain: Promise.resolve()
    }
    hostsById.set(hostId, state)
  }
  return state
}

async function sendUnregister(client: PushClient, timeoutMs: number): Promise<boolean> {
  const reply = await pushRouteUnregister
    .request(client, null, { timeoutMs, failWhenDisconnected: true })
    .catch(() => null)
  return reply !== null && pushRouteUnregister.interpret(reply).accepted
}

function enqueueReconcile(hostId: string): void {
  const state = hostsById.get(hostId)
  if (!state) {
    return
  }
  state.preparation?.releaseIfObsolete()
  state.dirty = true
  if (!state.running) {
    state.running = true
    state.chain = (async () => {
      while (state.dirty && hostsById.get(hostId) === state) {
        state.dirty = false
        try {
          await reconcileHost(hostId, reconciliation)
        } catch {
          console.warn('[push] Failed to reconcile notification registration')
        }
      }
      if (!state.target?.acknowledged) {
        state.target = undefined
      }
      state.running = false
    })()
  }
}

function reconcileAllHosts(): void {
  for (const hostId of hostsById.keys()) {
    enqueueReconcile(hostId)
  }
}

// Keep tracked host intent across disconnects; this disposer detaches only its current connected client.
export function attachPushRegistration(hostId: string, client: PushClient): () => void {
  const state = hostState(hostId)
  if (state.connection.client !== client) {
    state.capabilityProbeStop?.()
    state.capabilityProbeStop = null
    state.connection.client = client
    state.supported = null
    state.preparation?.releaseIfObsolete()
  }
  if (owner && !owner.token) {
    owner.refresh()
  }
  enqueueReconcile(hostId)
  const connection = state.connection
  return () => {
    if (connection.client === client) {
      connection.client = null
      state.capabilityProbeStop?.()
      state.capabilityProbeStop = null
      state.supported = null
      state.preparation?.releaseIfObsolete()
      const current = hostsById.get(hostId)
      if (current && current !== state) {
        current.capabilityProbeStop?.()
        current.capabilityProbeStop = null
        current.supported = null
        current.preparation?.releaseIfObsolete()
      }
    }
  }
}

// Consent completion covers local persistence; host reconciliation runs in the background.
export async function setRemotePushEnabled(enabled: boolean): Promise<void> {
  localOperations++
  invalidateIntent()
  try {
    await savePushNotificationsEnabled(enabled)
    await mutateRecords((current) => {
      if (!enabled) {
        for (const hostId of current.registered) {
          current.pending.add(hostId)
        }
      } else {
        current.pending.clear()
      }
    })
  } finally {
    completeLocalOperation()
  }
}

export async function setNotificationDeliveryPreferences(
  value: NotificationDeliveryPreferences
): Promise<void> {
  localOperations++
  invalidateIntent()
  try {
    await saveNotificationDeliveryPreferences(value)
  } finally {
    completeLocalOperation()
  }
}

function completeLocalOperation(): void {
  localOperations--
  if (localOperations === 0) {
    rederiveOwner()
  }
}

// Offline hosts retain the registration until unpaired or its mobile-use lease expires.
export async function unregisterPushForRemovedHost(hostId: string): Promise<() => void> {
  const state = hostsById.get(hostId)
  // Retire ownership before waiting for earlier RPCs to settle.
  hostsById.delete(hostId)
  state?.preparation?.releaseIfObsolete()
  state?.capabilityProbeStop?.()
  if (state) {
    state.target = undefined
    state.capabilityProbeStop = null
  }
  await state?.chain
  if (hostsById.has(hostId)) {
    return () => {}
  }
  if (state?.connection.client && state.supported !== false) {
    await sendUnregister(state.connection.client, REMOVAL_TIMEOUT_MS)
  }
  await mutateRecords((current) => {
    if (!hostsById.has(hostId)) {
      current.registered.delete(hostId)
      current.pending.delete(hostId)
    }
  }).catch(() => {})
  return () => {
    if (state && !hostsById.has(hostId)) {
      // Preserve disconnect ownership without reviving stale registration work.
      hostsById.set(hostId, { ...state, supported: null, capabilityProbeStop: null })
      enqueueReconcile(hostId)
    }
  }
}

function invalidateIntent(): void {
  consentGeneration++
  retireObsoletePreparations()
  owner?.invalidate()
}

function retireObsoletePreparations(): void {
  for (const state of hostsById.values()) {
    state.preparation?.releaseIfObsolete()
  }
}

function rederiveOwner(): void {
  owner?.rederive()
  reconcileAllHosts()
}

export function startPushTokenSync(): () => void {
  owner?.stop()
  const root = createMobilePushOwner(
    () => owner === root,
    () => consentGeneration,
    () => localOperations === 0,
    retireObsoletePreparations,
    () => {
      for (const state of hostsById.values()) {
        state.preparation?.releaseIfObsolete()
      }
      reconcileAllHosts()
    }
  )
  owner = root
  root.start()
  return () => {
    if (owner === root) {
      owner = undefined
    }
    root.stop()
  }
}

export function resetPushRegistrationForTests(): void {
  owner?.stop()
  owner = undefined
  const retired = [...hostsById.values()]
  hostsById.clear()
  for (const state of retired) {
    state.preparation?.releaseIfObsolete()
  }
  resetRegistrationRecords()
  consentGeneration = 0
  localOperations = 0
}

export function pushRegistrationSnapshotForTests() {
  return {
    preparations: [...hostsById.values()].filter((state) => state.preparation !== undefined).length,
    runners: [...hostsById.values()].filter((state) => state.running).length
  }
}
