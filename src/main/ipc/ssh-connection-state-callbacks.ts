import type { SshConnectionCallbacks } from '../ssh/ssh-connection'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import { rotateSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  connectInFlight,
  credentialRequestedForTarget,
  pendingTransportReconnects,
  testingTargets
} from './ssh-connect-attempt-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { requestCredential } from './ssh-passphrase'
import { clearRelayLostBackoff } from './ssh-relay-lost-backoff'
import {
  broadcastSshState,
  clearRelayStateOverride,
  publishRelayOverride,
  relayStateOverrides
} from './ssh-renderer-broadcast'

export function relayGracePeriodForTarget(
  target: SshTarget | null | undefined
): number | undefined {
  return target?.relayGracePeriodSeconds
}

// Why extracted from the callbacks object: an explicit connect pushes its own 'deploying-relay'
// through this exact path, so both callers share one implementation.
export function handleSshConnectionStateChange(targetId: string, state: SshConnectionState): void {
  if (testingTargets.has(targetId)) {
    return
  }

  // Why: an SSH reconnect must re-deploy the relay and rebuild providers; the guard below fires only for real reconnects, not an explicit connect's 'deploying'.
  const session = activeSessions.get(targetId)
  const sessionState = session?.getState()
  const transportReconnectStarted =
    state.status === 'reconnecting' &&
    (sessionState === 'ready' || sessionState === 'reconnecting') &&
    !pendingTransportReconnects.has(targetId)
  if (transportReconnectStarted) {
    rotateSshProviderAuthority(targetId)
    pendingTransportReconnects.add(targetId)
  } else if (
    state.status === 'disconnected' ||
    state.status === 'auth-failed' ||
    state.status === 'reconnection-failed' ||
    state.status === 'error'
  ) {
    pendingTransportReconnects.delete(targetId)
  }
  const completedTransportReconnect =
    state.status === 'connected' && pendingTransportReconnects.delete(targetId)
  const shouldReconnectRelay =
    session !== undefined &&
    completedTransportReconnect &&
    state.reconnectAttempt === 0 &&
    (sessionState === 'ready' || sessionState === 'reconnecting')
  const relayReconnectAlreadyInFlight =
    !completedTransportReconnect &&
    state.status === 'connected' &&
    sessionState === 'reconnecting' &&
    relayStateOverrides.has(targetId)

  if (shouldReconnectRelay) {
    // Why: this branch redeploys the relay itself over a fresh transport, so any pending relay-lost retry is stale — dropping it also gives the new transport generation a full attempt budget.
    clearRelayLostBackoff(targetId)
    // Why: SSH connects before the relay providers rebuild; keep renderer actions gated until SshRelaySession reaches ready again.
    publishRelayOverride(
      getCurrentMainWindow,
      targetId,
      'reconnecting',
      'Relay channel reconnecting...',
      state.reconnectAttempt
    )
  } else if (relayReconnectAlreadyInFlight) {
    // Why: duplicate connected notifications belong to the same socket generation and must not expose providers before relay recovery finishes.
    return
  } else if (
    state.status === 'connected' &&
    session !== undefined &&
    sessionState !== 'ready' &&
    !completedTransportReconnect &&
    connectInFlight.has(targetId)
  ) {
    // Why: the raw SSH transport reaches 'connected' before the relay session establishes during an
    // explicit connect. Forwarding it makes the renderer treat the host as fully up — it remounts
    // SSH panes (-> window.api.ssh.connect) and fires connected-gated data reads before any provider
    // exists. On a permanent relay-deploy failure that premature 'connected' drives an unbounded
    // reconnect loop. Hold it at 'deploying-relay'; the in-flight doConnect broadcasts the
    // authoritative 'connected' directly (bypassing this callback) after establish() succeeds, or a
    // terminal state on failure. The connectInFlight gate keeps this scoped to a live connect, so a
    // stray raw 'connected' with no follow-up (e.g. a transport blip on a session left 'idle' by a
    // relay version mismatch) is never wedged at 'deploying-relay'.
    clearRelayStateOverride(targetId)
    broadcastSshState(getCurrentMainWindow, targetId, {
      targetId,
      status: 'deploying-relay',
      error: state.error,
      reconnectAttempt: state.reconnectAttempt
    })
  } else {
    clearRelayStateOverride(targetId)
    broadcastSshState(getCurrentMainWindow, targetId, state)
  }

  if (!session) {
    return
  }
  // Why: allow reconnect from both 'ready' and 'reconnecting'; without the latter, a failed relay deploy would permanently brick the session.
  if (shouldReconnectRelay) {
    const target = getSshTargetRegistryStore()?.getTarget(targetId)
    const conn = connectionManager?.getConnection(targetId)
    if (conn) {
      void session.reconnect(conn, relayGracePeriodForTarget(target))
    }
  }
}

export function createSshConnectionCallbacks(): SshConnectionCallbacks {
  return {
    onCredentialRequest: (targetId, kind, detail) => {
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getCurrentMainWindow, targetId, kind, detail)
    },
    onStateChange: handleSshConnectionStateChange
  }
}
