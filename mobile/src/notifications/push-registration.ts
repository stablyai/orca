import { ensureDesktopNotificationChannel } from './foreground-delivery/desktop-notification-channel'
import {
  createHostPushSupportCompletion,
  createHostPushState,
  type HostPushState,
  type HostPushSupportCompletion
} from './push-registration/host-push-registration-state'
import { AppState } from 'react-native'
import { startMobilePushLeaseRenewal } from './push-registration/mobile-push-lease-renewal'
import {
  loadNotificationDeliveryPreferences,
  notificationPreferencesFilter,
  saveNotificationDeliveryPreferences,
  type NotificationDeliveryPreferences
} from './delivery-policy/notification-delivery-preferences'
import { NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY as NOTIFICATIONS_REMOTE_PUSH_CAPABILITY } from '../../../src/shared/mobile-runtime-capabilities'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import { startRuntimeCapabilityProbe } from '../transport/connection/runtime-capability-probe'
import {
  sendRegister,
  sendUnregister
} from './push-registration/mobile-push-registration-operations'
import {
  loadPushNotificationsEnabled,
  loadRemotePushHostRegistrations,
  savePushNotificationsEnabled,
  saveRemotePushHostRegistrations
} from '../storage/preferences'
import {
  addPushTokenListener,
  getDevicePushToken,
  type MobilePushToken
} from './push-registration/push-token'

const REQUEST_TIMEOUT_MS = 5_000
const REMOVAL_TIMEOUT_MS = 2_000
const TOKEN_TIMEOUT_MS = 2_000

type RegistrationRecords = { registered: Set<string>; pending: Set<string> }

const hostsById = new Map<string, HostPushState>()

export function getHostPushSupported(hostId: string): boolean | null {
  return hostsById.get(hostId)?.supported ?? null
}
export function getHostPushSupportCompletion(
  hostId: string,
  client: UnvalidatedRpcRequestPort
): HostPushSupportCompletion | null {
  const connection = hostsById.get(hostId)?.connection
  return connection?.client === client ? connection.support : null
}
let registrationRecords: RegistrationRecords | null = null
let tokenPromise: Promise<MobilePushToken | null> | null = null
// A late registration must not overwrite a newer preference or consent choice.
let consentGeneration = 0

function hostState(hostId: string): HostPushState {
  let state = hostsById.get(hostId)
  if (!state) {
    state = createHostPushState()
    hostsById.set(hostId, state)
  }
  return state
}

async function readRecords(): Promise<RegistrationRecords> {
  if (!registrationRecords) {
    const stored = await loadRemotePushHostRegistrations()
    registrationRecords ??= {
      registered: new Set(stored.registeredHostIds),
      pending: new Set(stored.pendingUnregisterHostIds)
    }
  }
  return registrationRecords
}

async function mutateRecords(mutate: (value: RegistrationRecords) => void): Promise<void> {
  const value = await readRecords()
  mutate(value)
  await saveRemotePushHostRegistrations({
    registeredHostIds: [...value.registered],
    pendingUnregisterHostIds: [...value.pending]
  })
}

// A missing token is retried: APNs registration may still be in flight.
async function currentToken(): Promise<MobilePushToken | null> {
  await ensureDesktopNotificationChannel()
  if (!tokenPromise) {
    const pending: Promise<MobilePushToken | null> = getDevicePushToken().then((token) => {
      if (!token && tokenPromise === pending) {
        tokenPromise = null
      }
      return token
    })
    tokenPromise = pending
  }
  return tokenPromise
}

async function reconcileHost(hostId: string): Promise<void> {
  const state = hostsById.get(hostId)
  const client = state?.connection.client
  if (!state || !client) {
    return
  }
  const generation = consentGeneration
  const isCurrent = () => hostsById.get(hostId) === state && state.connection.client === client
  const value = await readRecords()
  // Unregister intent takes priority even before the capability probe answers.
  if (value.pending.has(hostId)) {
    if (state.supported === false || !(await sendUnregister(client, REQUEST_TIMEOUT_MS))) {
      return
    }
    await mutateRecords((current) => {
      current.pending.delete(hostId)
      current.registered.delete(hostId)
    })
    // A preference change can invalidate a register without disabling push.
    if (!(await loadPushNotificationsEnabled())) {
      return
    }
  }
  if (state.supported == null) {
    if (!isCurrent()) {
      return
    }
    state.capabilityProbeStop ??= startRuntimeCapabilityProbe(client, (capabilities) => {
      if (!isCurrent()) {
        return
      }
      state.supported = capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_CAPABILITY)
      state.connection.support?.complete(state.supported)
      void enqueueReconcile(hostId)
    })
    return
  }
  if (!state.supported || !isCurrent()) {
    return
  }
  if (!(await loadPushNotificationsEnabled())) {
    // Saved consent recovers a disable even if its pending-record write failed.
    if (await sendUnregister(client, REQUEST_TIMEOUT_MS)) {
      await mutateRecords((current) => {
        current.pending.delete(hostId)
        current.registered.delete(hostId)
      })
    }
    return
  }
  if (AppState.currentState !== 'active') {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const token = await Promise.race([
    currentToken(),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS)
    })
  ]).finally(() => clearTimeout(timer))
  const filter = notificationPreferencesFilter(await loadNotificationDeliveryPreferences())
  if (
    !token ||
    !isCurrent() ||
    generation !== consentGeneration ||
    AppState.currentState !== 'active'
  ) {
    return
  }
  if (!(await sendRegister(client, token, filter)) || hostsById.get(hostId) !== state) {
    return
  }
  if (generation !== consentGeneration) {
    await mutateRecords((current) => current.pending.add(hostId))
    void enqueueReconcile(hostId)
    return
  }
  await mutateRecords((current) => current.registered.add(hostId))
}

function enqueueReconcile(hostId: string): Promise<void> {
  const state = hostState(hostId)
  const run = state.chain
    .then(() => (hostsById.get(hostId) === state ? reconcileHost(hostId) : undefined))
    .catch(() => {
      console.warn('[push] Failed to reconcile notification registration')
    })
  state.chain = run
  return run
}

async function reconcileAllHosts(): Promise<void> {
  await Promise.all([...hostsById.keys()].map((hostId) => enqueueReconcile(hostId)))
}

// Keep tracked host intent across disconnects; this disposer detaches only its current connected client.
export function attachPushRegistration(
  hostId: string,
  client: UnvalidatedRpcRequestPort
): () => void {
  const state = hostState(hostId)
  if (state.connection.client !== client) {
    state.capabilityProbeStop?.()
    state.capabilityProbeStop = null
    state.connection.support?.retire()
    state.connection.support = createHostPushSupportCompletion()
    state.connection.client = client
    state.supported = null
  }
  void enqueueReconcile(hostId)
  const connection = state.connection
  return () => {
    if (connection.client === client) {
      connection.support?.retire()
      connection.support = null
      connection.client = null
      state.capabilityProbeStop?.()
      state.capabilityProbeStop = null
      state.supported = null
      const current = hostsById.get(hostId)
      if (current && current !== state) {
        current.capabilityProbeStop?.()
        current.capabilityProbeStop = null
        current.supported = null
      }
    }
  }
}

// Consent completion covers local persistence; host reconciliation runs in the background.
export async function setRemotePushEnabled(enabled: boolean): Promise<void> {
  consentGeneration++
  await savePushNotificationsEnabled(enabled)
  try {
    await mutateRecords((current) => {
      if (!enabled) {
        for (const hostId of current.registered) {
          current.pending.add(hostId)
        }
        return
      }
      current.pending.clear()
    })
  } finally {
    void reconcileAllHosts()
  }
}

export async function setNotificationDeliveryPreferences(
  value: NotificationDeliveryPreferences
): Promise<void> {
  consentGeneration++
  await saveNotificationDeliveryPreferences(value)
  await reconcileAllHosts()
}

// Offline hosts retain the registration until unpaired or its mobile-use lease expires.
export async function unregisterPushForRemovedHost(hostId: string): Promise<() => void> {
  const state = hostsById.get(hostId)
  // Retire ownership before waiting for earlier RPCs to settle.
  hostsById.delete(hostId)
  state?.connection.support?.retire()
  state?.capabilityProbeStop?.()
  if (state) {
    state.capabilityProbeStop = null
  }
  await state?.chain
  if (state?.connection.client && state.supported !== false) {
    await sendUnregister(state.connection.client, REMOVAL_TIMEOUT_MS)
  }
  await mutateRecords((current) => {
    current.registered.delete(hostId)
    current.pending.delete(hostId)
  }).catch(() => {})
  return () => {
    if (state && !hostsById.has(hostId)) {
      // Preserve disconnect ownership without reviving stale registration work.
      state.connection.support = state.connection.client ? createHostPushSupportCompletion() : null
      hostsById.set(hostId, { ...state, supported: null, capabilityProbeStop: null })
      void enqueueReconcile(hostId)
    }
  }
}

// Provider token rollover invalidates delivery, so refresh every connected host immediately.
export function startPushTokenSync(): () => void {
  const stopLease = startMobilePushLeaseRenewal(reconcileAllHosts)
  const stopToken = addPushTokenListener((token) => {
    tokenPromise = Promise.resolve(token)
    void reconcileAllHosts()
  })
  return () => {
    stopLease()
    stopToken()
  }
}

export function resetPushRegistrationForTests(): void {
  for (const state of hostsById.values()) {
    state.connection.support?.retire()
  }
  hostsById.clear()
  registrationRecords = null
  tokenPromise = null
  consentGeneration = 0
}
