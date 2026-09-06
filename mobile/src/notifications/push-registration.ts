import type {
  MobilePushRegisterInput,
  MobilePushRegisterResult
} from '../../../src/shared/mobile-push-contract'
import { NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import {
  loadRemotePushEnabled,
  loadRemotePushFilter,
  loadRemotePushHostRegistrations,
  saveRemotePushAgentStates,
  saveRemotePushEnabled,
  saveRemotePushHostRegistrations,
  type RemotePushAgentState,
  type RemotePushFilter
} from '../storage/preferences'
import { addPushTokenListener, getDevicePushToken, type MobilePushToken } from './push-token'

// Advertised statically by hosts that can reach Orca's push gateway; a host without
// it never sees a registerPush call. Sourced from the shared contract so a host bump
// cannot silently drift from the mobile probe.
export const NOTIFICATIONS_REMOTE_PUSH_CAPABILITY = NOTIFICATIONS_REMOTE_PUSH_RUNTIME_CAPABILITY

type PushClient = Pick<RpcClient, 'sendRequest'>

const REQUEST_TIMEOUT_MS = 5_000
// Unpairing must not sit behind a wedged socket; the desktop's own revoke path
// enqueues the gateway delete regardless of whether this call lands.
const REMOVAL_TIMEOUT_MS = 2_000

type HostPushState = {
  client: PushClient | null
  // null until the host ANSWERS; reset whenever the client is replaced, since a
  // reconnect can land on a host that was upgraded (or downgraded) in the meantime.
  // A probe that failed leaves it null so the next reconcile asks again.
  supported: boolean | null
  chain: Promise<void>
}

type RegistrationRecords = { registered: Set<string>; pending: Set<string> }

const hostsById = new Map<string, HostPushState>()
let registrationRecords: RegistrationRecords | null = null
let tokenPromise: Promise<MobilePushToken | null> | null = null
// Bumped on every switch change. A register that returns across a bump raced a
// switch-off whose unregister sweep had already snapshotted `registered`, so
// recording its success would leave the gateway pushing with the switch showing off.
let consentGeneration = 0

function hostState(hostId: string): HostPushState {
  let state = hostsById.get(hostId)
  if (!state) {
    state = { client: null, supported: null, chain: Promise.resolve() }
    hostsById.set(hostId, state)
  }
  return state
}

async function readRecords(): Promise<RegistrationRecords> {
  if (!registrationRecords) {
    const stored = await loadRemotePushHostRegistrations()
    // Re-checked after the await: a concurrent reconcile may have seeded it.
    registrationRecords ??= {
      registered: new Set(stored.registeredHostIds),
      pending: new Set(stored.pendingUnregisterHostIds)
    }
  }
  return registrationRecords
}

// Interleaving writers are safe: they mutate one shared object, so the later save
// carries both mutations rather than clobbering the earlier one.
async function mutateRecords(mutate: (value: RegistrationRecords) => void): Promise<void> {
  const value = await readRecords()
  mutate(value)
  await saveRemotePushHostRegistrations({
    registeredHostIds: [...value.registered],
    pendingUnregisterHostIds: [...value.pending]
  }).catch(() => {})
}

async function currentToken(): Promise<MobilePushToken | null> {
  if (!tokenPromise) {
    // Why a null answer is not cached: the device may simply have no token YET —
    // APNs registration still in flight, permission just granted — and holding that
    // null for the app's lifetime stops every later reconcile from registering.
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

// null means the host never answered — a timeout, a wedged socket, an error reply.
// That is not evidence of absence, so the caller must not cache it as "no".
async function readRemotePushCapability(client: PushClient): Promise<boolean | null> {
  try {
    const response = await client.sendRequest('status.get')
    if (!response.ok) {
      return null
    }
    const result = response.result
    if (!result || typeof result !== 'object') {
      return false
    }
    const capabilities = (result as { capabilities?: unknown }).capabilities
    return (
      Array.isArray(capabilities) && capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_CAPABILITY)
    )
  } catch {
    return null
  }
}

async function sendRegister(
  client: PushClient,
  token: MobilePushToken,
  filter: RemotePushFilter
): Promise<boolean> {
  // deviceId is deliberately absent: the host takes it from the paired session, so a
  // phone can never register a token against a device other than itself.
  const params: Omit<MobilePushRegisterInput, 'deviceId'> = {
    platform: token.platform,
    token: token.token,
    ...(token.apnsEnvironment ? { apnsEnvironment: token.apnsEnvironment } : {}),
    filter: { sources: [...filter.sources], agentStates: [...filter.agentStates] }
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

// A `{ unregistered: false }` answer still counts: the host processed the request and
// holds no registration, which is exactly the state the retry was chasing.
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
  const client = state?.client
  if (!state || !client) {
    return
  }
  const generation = consentGeneration
  const value = await readRecords()
  // Why this sits ABOVE the capability gate: a pending entry is a switch-off the user
  // already performed, and gating it on a probe means one unanswered status.get keeps
  // the gateway pushing to a phone whose switch reads off. Only a host that positively
  // answered "no" is skipped — it cannot be holding a registration.
  if (value.pending.has(hostId)) {
    if (state.supported !== false && (await sendUnregister(client, REQUEST_TIMEOUT_MS))) {
      await mutateRecords((current) => {
        current.pending.delete(hostId)
        current.registered.delete(hostId)
      })
    }
    return
  }
  if (state.supported == null) {
    const probed = await readRemotePushCapability(client)
    if (state.client !== client) {
      return
    }
    if (probed == null) {
      return
    }
    state.supported = probed
  }
  if (!state.supported || state.client !== client) {
    return
  }
  if (!(await loadRemotePushEnabled())) {
    return
  }
  const token = await currentToken()
  if (!token) {
    return
  }
  if (!(await sendRegister(client, token, await loadRemotePushFilter()))) {
    return
  }
  if (generation !== consentGeneration) {
    // The switch moved while this register was in flight. Recording it would add the
    // host to `registered` after the sweep read that set, so re-arm the unregister.
    await mutateRecords((current) => current.pending.add(hostId))
    void enqueueReconcile(hostId)
    return
  }
  await mutateRecords((current) => current.registered.add(hostId))
}

function enqueueReconcile(hostId: string): Promise<void> {
  const state = hostState(hostId)
  const run = state.chain.then(() => reconcileHost(hostId)).catch(() => {})
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
  if (state.client !== client) {
    state.client = client
    state.supported = null
  }
  void enqueueReconcile(hostId)
  return () => {
    if (state.client === client) {
      state.client = null
    }
  }
}

export async function setRemotePushEnabled(enabled: boolean): Promise<void> {
  consentGeneration++
  await saveRemotePushEnabled(enabled)
  await mutateRecords((current) => {
    if (!enabled) {
      // Why every registered host and not just the connected ones: an offline host
      // still holds a live gateway registration, so the intent has to outlive the tap.
      for (const hostId of current.registered) {
        current.pending.add(hostId)
      }
      return
    }
    current.pending.clear()
  })
  await reconcileAllHosts()
}

/** Re-registers every connected host so the gateway stores the narrowed filter. */
export async function setRemotePushAgentStates(
  states: readonly RemotePushAgentState[]
): Promise<void> {
  await saveRemotePushAgentStates(states)
  await reconcileAllHosts()
}

/**
 * Best-effort unregister before the host's credentials are deleted.
 *
 * Why best-effort is all there is: the credentials are the only way back to that
 * host, so a desktop that was offline here keeps its gateway registration and keeps
 * pushing to this phone. shouldSuppressForegroundPush drops those in the foreground;
 * background alerts stop only when that desktop unpairs the phone, or the switch is
 * turned off here. Documented in docs/site/content/docs/notifications.mdx.
 */
export async function unregisterPushForRemovedHost(hostId: string): Promise<void> {
  const state = hostsById.get(hostId)
  if (state?.client && state.supported !== false) {
    await sendUnregister(state.client, REMOVAL_TIMEOUT_MS)
  }
  hostsById.delete(hostId)
  // No retry is possible once the host is gone, so drop it rather than leave a
  // pending entry that every later reconcile would carry forever.
  await mutateRecords((current) => {
    current.registered.delete(hostId)
    current.pending.delete(hostId)
  })
}

/** A rolled token stops delivering, so re-register every connected host at once. */
export function startPushTokenSync(): () => void {
  return addPushTokenListener((token) => {
    tokenPromise = Promise.resolve(token)
    void reconcileAllHosts()
  })
}

export function resetPushRegistrationForTests(): void {
  hostsById.clear()
  registrationRecords = null
  tokenPromise = null
  consentGeneration = 0
}
