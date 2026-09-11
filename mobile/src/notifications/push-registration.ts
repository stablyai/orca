import { ensureDesktopNotificationChannel } from './desktop-notification-channel'
import { AppState } from 'react-native'
import { startMobilePushLeaseRenewal } from './mobile-push-lease-renewal'
import {
  loadNotificationDeliveryPreferences,
  notificationPreferencesFilter,
  saveNotificationDeliveryPreferences,
  type NotificationDeliveryPreferences
} from './notification-delivery-preferences'
import type {
  MobilePushFilter,
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../../src/shared/mobile-push-contract'
import { NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import {
  loadPushNotificationsEnabled,
  loadRemotePushHostRegistrations,
  savePushNotificationsEnabled,
  saveRemotePushHostRegistrations
} from '../storage/preferences'
import { addPushTokenListener, getDevicePushToken, type MobilePushToken } from './push-token'

export const NOTIFICATIONS_REMOTE_PUSH_CAPABILITY = NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY

type PushClient = Pick<RpcClient, 'sendRequest'>

const REQUEST_TIMEOUT_MS = 5_000
const REMOVAL_TIMEOUT_MS = 2_000
const TOKEN_TIMEOUT_MS = 2_000

type HostPushState = {
  connection: { client: PushClient | null }
  // An unanswered probe is unknown, not unsupported.
  supported: boolean | null
  capabilityProbeStop: (() => void) | null
  chain: Promise<void>
}

type RegistrationRecords = { registered: Set<string>; pending: Set<string> }

const hostsById = new Map<string, HostPushState>()
let registrationRecords: RegistrationRecords | null = null
let tokenPromise: Promise<MobilePushToken | null> | null = null
// A late registration must not overwrite a newer preference or consent choice.
let consentGeneration = 0

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

async function sendRegister(
  client: PushClient,
  token: MobilePushToken,
  filter: MobilePushFilter
): Promise<boolean> {
  const params: Omit<MobilePushRegisterInput, 'deviceId'> = {
    platform: token.platform,
    token: token.token,
    ...(token.apnsEnvironment ? { apnsEnvironment: token.apnsEnvironment } : {}),
    filter
  }
  const response = await client
    .sendRequest('notifications.registerPush', params, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      failWhenDisconnected: true
    })
    .catch(() => null)
  if (!response?.ok) {
    return false
  }
  return (response.result as MobilePushRegisterResult | null)?.registered === true
}

async function sendUnregister(client: PushClient, timeoutMs: number): Promise<boolean> {
  const response = await client
    .sendRequest('notifications.unregisterPush', null, {
      timeoutMs,
      failWhenDisconnected: true
    })
    .catch(() => null)
  return response?.ok === true
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
    state.capabilityProbeStop ??= startRuntimeCapabilityProbe(client, (capabilities) => {
      if (state.connection.client !== client) {
        return
      }
      state.supported = capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_CAPABILITY)
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

/**
 * Track a host whose client has reached `connected`, registering (or retrying a
 * pending unregister) as the current preference requires. The returned function
 * detaches the client on disconnect; the host's tracked state survives it.
 */
export function attachPushRegistration(hostId: string, client: PushClient): () => void {
  const state = hostState(hostId)
  if (state.connection.client !== client) {
    state.capabilityProbeStop?.()
    state.connection.client = client
    state.supported = null
  }
  void enqueueReconcile(hostId)
  const connection = state.connection
  return () => {
    if (connection.client === client) {
      connection.client = null
      state.capabilityProbeStop?.()
      state.capabilityProbeStop = null
      state.supported = null
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
      hostsById.set(hostId, { ...state, supported: null })
      void enqueueReconcile(hostId)
    }
  }
}

/** A rolled token stops delivering, so re-register every connected host at once. */
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
  hostsById.clear()
  registrationRecords = null
  tokenPromise = null
  consentGeneration = 0
}
