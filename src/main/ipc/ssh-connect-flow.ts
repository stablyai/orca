import { appendFileSync } from 'node:fs'
import type { SshConnection } from '../ssh/ssh-connection'
import { SshRelaySession } from '../ssh/ssh-relay-session'
import type { SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'
import { createCancelledConnectAttemptError } from '../ssh/ssh-connect-attempt-cancellation'
import { isAuthError } from '../ssh/ssh-connection-utils'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../ssh/ssh-provider-authority'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  credentialRequestedForTarget,
  isCurrentConnectAttempt,
  pendingTransportReconnects,
  resetRelayInFlight
} from './ssh-connect-attempt-registry'
import {
  handleSshConnectionStateChange,
  relayGracePeriodForTarget
} from './ssh-connection-state-callbacks'
import {
  connectionManager,
  currentRuntime,
  getCurrentMainWindow,
  persistedStore,
  portForwardManager
} from './ssh-ipc-context'
import { clearRelayLostBackoff, relayLostBackoff } from './ssh-relay-lost-backoff'
import { configureRelaySessionCallbacks } from './ssh-relay-session-callbacks'
import {
  broadcastDetectedPortsFromCurrentWindow,
  broadcastSshState,
  clearRelayStateOverride,
  getPublicSshState,
  relayStateOverrides
} from './ssh-renderer-broadcast'
import { abandonCancelledConnectAttempt, abandonFailedSshSession } from './ssh-session-teardown'
import { awaitTargetLifecycle } from './ssh-target-lifecycle-queue'

export async function connectTarget(targetId: string): Promise<SshConnectionState> {
  const e2eProbePath = process.env.ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE
  if (e2eProbePath) {
    appendFileSync(e2eProbePath, `${JSON.stringify(targetId)}\n`)
    throw new Error('e2e_forbidden_local_ssh_connect')
  }
  // Why: fence callers that entered before a same-turn disconnect/reset but resume after its cleanup.
  const admissionAuthority = getSshProviderAuthority(targetId)
  await awaitTargetLifecycle(targetId)
  const reset = resetRelayInFlight.get(targetId)
  if (reset) {
    await reset
  }

  // Why: serialize concurrent ssh:connect for the same target; interleaved connects otherwise leak the first session.
  const existing = connectInFlight.get(targetId)
  let replacePendingTransport = false
  if (existing) {
    if (isCurrentConnectAttempt(targetId, existing.authority)) {
      return existing.promise
    }
  }
  if (!isCurrentConnectAttempt(targetId, admissionAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  const observedAuthority = admissionAuthority
  if (existing) {
    if (connectInFlight.get(targetId) === existing) {
      connectInFlight.delete(targetId)
      replacePendingTransport = true
    }
  }
  if (!isCurrentSshProviderAuthority(observedAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  // Why: the shutdown drain fences and snapshots synchronously, so a connect either registers in
  // connectInFlight below (and gets joined) or fails here — it can never slip between the two.
  assertSshConnectsNotFenced()

  pendingTransportReconnects.delete(targetId)
  const promise = doConnect(targetId, replacePendingTransport)
  const attempt = { authority: getSshProviderAuthority(targetId), promise }
  connectInFlight.set(targetId, attempt)
  try {
    return await promise
  } finally {
    if (connectInFlight.get(targetId) === attempt) {
      connectInFlight.delete(targetId)
    }
  }
}

async function doConnect(
  targetId: string,
  replacePendingTransport = false
): Promise<SshConnectionState> {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (!target) {
    throw new Error(`SSH target "${targetId}" not found`)
  }

  const existingSession = activeSessions.get(targetId)
  const existingState = connectionManager!.getState(targetId)
  const existingMux = existingSession?.getMux()
  if (
    existingSession?.getState() === 'ready' &&
    existingState?.status === 'connected' &&
    connectionManager!.getConnection(targetId) &&
    existingMux &&
    !existingMux.isDisposed() &&
    !relayStateOverrides.has(targetId) &&
    !relayLostBackoff.has(targetId)
  ) {
    // Why: BrowserWindow reactivation re-fires ssh:connect for already-live targets; treat as a refresh instead of tearing down the relay and its forwards.
    broadcastSshState(getCurrentMainWindow, targetId, existingState)
    return getPublicSshState(targetId)!
  }

  const authority = rotateSshProviderAuthority(targetId)
  clearRelayStateOverride(targetId)
  const pendingTransportDisconnect = replacePendingTransport
    ? connectionManager!.disconnect(targetId).then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const
      )
    : null
  let conn
  // Why: tear down any existing session first to avoid leaking its multiplexer, providers, and timers (double-connect / reconnect-after-error).
  if (existingSession) {
    // Why: await port teardown before disposing, else the new session's restorePortForwards can hit EADDRINUSE on not-yet-released ports.
    await portForwardManager!.removeAllForwards(targetId)
    if (!isCurrentConnectAttempt(targetId, authority)) {
      throw createCancelledConnectAttemptError()
    }
    try {
      await existingSession.detachAndPersist()
    } finally {
      // Why finally: detachAndPersist runs its in-memory half synchronously, so the session is
      // dead even when the lease write rejects — keeping it in activeSessions would strand every
      // later connect on the same dead session. Why still after the await, not before it: the
      // write has settled by now, so it can no longer clobber the replacement's 'attached' write.
      if (activeSessions.get(targetId) === existingSession) {
        activeSessions.delete(targetId)
        clearRelayLostBackoff(targetId)
        clearRelayStateOverride(targetId)
      }
    }
  }

  if (pendingTransportDisconnect) {
    const disconnectResult = await pendingTransportDisconnect
    if (!disconnectResult.ok) {
      throw disconnectResult.error
    }
    if (!isCurrentConnectAttempt(targetId, authority)) {
      throw createCancelledConnectAttemptError()
    }
  }

  // Why here and not only at entry: this is the publication point, and it is the last statement
  // before the transport opens. Checking it in the same synchronous block as activeSessions.set
  // means a connect either registers before the shutdown drain snapshots, or registers never and
  // owns nothing to clean up.
  assertSshConnectsNotFenced()
  // Why: create the session early so onStateChange sees it in 'deploying' and skips reconnect logic.
  const session = new SshRelaySession(
    targetId,
    getCurrentMainWindow,
    persistedStore!,
    portForwardManager!,
    currentRuntime,
    broadcastDetectedPortsFromCurrentWindow
  )
  configureRelaySessionCallbacks(session)
  activeSessions.set(targetId, session)
  const ownsSession = (): boolean =>
    isCurrentConnectAttempt(targetId, authority) && activeSessions.get(targetId) === session

  // Why captured here and not with existingState: connect() reuses an already-connected transport,
  // and only a transport this attempt opened is this attempt's to close when it loses the race.
  const priorConnection = connectionManager!.getConnection(targetId)
  const mintedConnection = (): SshConnection | null =>
    conn && conn !== priorConnection ? conn : null

  try {
    conn = await connectionManager!.connect(target)
    if (!ownsSession()) {
      throw createCancelledConnectAttemptError()
    }
  } catch (err) {
    // Why: connect()'s internal state may not have reached the renderer; broadcast explicitly so the UI leaves 'connecting'.
    const errObj = err instanceof Error ? err : new Error(String(err))
    const status: SshConnectionStatus = isAuthError(errObj) ? 'auth-failed' : 'error'
    if (!ownsSession()) {
      await abandonCancelledConnectAttempt(targetId, session, mintedConnection())
      throw createCancelledConnectAttemptError()
    }
    // Why: clear this failed connect's flag so a later non-prompting connect isn't deferred.
    credentialRequestedForTarget.delete(targetId)
    await abandonFailedSshSession(targetId, session)
    clearRelayLostBackoff(targetId)
    clearRelayStateOverride(targetId)
    broadcastSshState(getCurrentMainWindow, targetId, {
      targetId,
      status,
      error: errObj.message,
      reconnectAttempt: 0
    })
    throw err
  }

  try {
    handleSshConnectionStateChange(targetId, {
      targetId,
      status: 'deploying-relay',
      error: null,
      reconnectAttempt: 0
    })

    await session.establish(conn, relayGracePeriodForTarget(target))
    if (!ownsSession()) {
      throw createCancelledConnectAttemptError()
    }

    // Why: we manually pushed `deploying-relay`, so send `connected` straight to the renderer — routing through onStateChange would trigger reconnect logic.
    clearRelayStateOverride(targetId)
    broadcastSshState(getCurrentMainWindow, targetId, {
      targetId,
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      supportsFolderDownload: conn.usesSystemSshTransport?.() !== true
    })
  } catch (err) {
    if (!ownsSession()) {
      await abandonCancelledConnectAttempt(targetId, session, mintedConnection())
      throw createCancelledConnectAttemptError()
    }
    await abandonFailedSshSession(targetId, session)
    clearRelayLostBackoff(targetId)
    try {
      await connectionManager!.disconnect(targetId)
    } catch (disconnectError) {
      // Why: the establish failure is the actionable error; a teardown throw must not replace it.
      console.warn(
        `[ssh] Failed to disconnect transport after failed establish for ${targetId}: ${disconnectError instanceof Error ? disconnectError.message : String(disconnectError)}`
      )
    }
    throw err
  }

  // Why: persist whether this connect needed a credential so startup can partition targets into eager vs deferred without re-probing keys.
  const requiredPassphrase = credentialRequestedForTarget.has(targetId)
  credentialRequestedForTarget.delete(targetId)
  getSshTargetRegistryStore()!.updateTarget(targetId, {
    lastRequiredPassphrase: requiredPassphrase
  })

  return getPublicSshState(targetId)!
}
