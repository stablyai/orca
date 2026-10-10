import type { SshConnectionCallbacks } from '../ssh/ssh-connection'
import type { SshConnectionState } from '../../shared/ssh-types'
import { isSshHostCensusInFlight } from '../ssh/ssh-connection-attribution'
import { connectInFlight, credentialRequestedForTarget, testingTargets } from './ssh-connect-attempt-registry'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { requestCredential } from './ssh-passphrase'
import { broadcastSshState } from './ssh-renderer-broadcast'

export function handleSshConnectionStateChange(targetId: string, state: SshConnectionState): void {
  if (testingTargets.has(targetId)) {
    return
  }
  if (
    state.status === 'connected' &&
    (connectInFlight.has(targetId) || isSshHostCensusInFlight(targetId))
  ) {
    // Why: the raw transport reaches 'connected' while the connect is still deciding the host's
    // server; forwarding it would let the renderer treat the host as up before anything serves it.
    broadcastSshState(getCurrentMainWindow, targetId, {
      targetId,
      status: 'connecting',
      error: state.error,
      reconnectAttempt: state.reconnectAttempt
    })
    return
  }
  broadcastSshState(getCurrentMainWindow, targetId, state)
}

export function createSshConnectionCallbacks(): SshConnectionCallbacks {
  return {
    onCredentialRequest: (targetId, kind, detail, echo, signal) => {
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getCurrentMainWindow, targetId, kind, detail, echo, signal)
    },
    onStateChange: handleSshConnectionStateChange
  }
}
