import type { SshConnectionCallbacks } from '../../ssh/connection/ssh-connection-callbacks'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { isSshHostCensusInFlight } from '../../ssh/connection/ssh-connection-attribution'
import {
  clearSshCredentialDeclined,
  isSshCredentialDeclined
} from '../../ssh/ssh-credential-decline'
import {
  connectInFlight,
  credentialRequestedForTarget,
  testingTargets
} from './ssh-connect-attempt-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { recordSshSignInRequirement } from './ssh-sign-in-requirement'
import { restoreManagedHostPortForwards } from './ssh-managed-port-forward-restore'
import { requestCredential } from './ssh-passphrase'
import { broadcastSshState } from './ssh-renderer-broadcast'

export function handleSshConnectionStateChange(targetId: string, state: SshConnectionState): void {
  if (state.status === 'connected') {
    clearSshCredentialDeclined(targetId)
    recordSshSignInRequirement(targetId, getSshTargetRegistryStore(), connectionManager)
  }
  if (testingTargets.has(targetId)) {
    return
  }
  if (
    state.status === 'connected' &&
    (connectInFlight.has(targetId) || isSshHostCensusInFlight(targetId))
  ) {
    // Raw transport connected is premature while the host server decision is still pending.
    broadcastSshState(getCurrentMainWindow, targetId, {
      targetId,
      status: 'connecting',
      error: state.error,
      reconnectAttempt: state.reconnectAttempt
    })
    return
  }
  broadcastSshState(getCurrentMainWindow, targetId, state)
  // An explicit connect restores through its own publish; this covers a transport that recovered.
  if (state.status === 'connected') {
    void restoreManagedHostPortForwards(targetId)
  }
}

export function createSshConnectionCallbacks(): SshConnectionCallbacks {
  return {
    onCredentialRequest: (targetId, kind, detail, echo, signal) => {
      // After Cancel, only explicit connects may prompt again.
      if (isSshCredentialDeclined(targetId, signal)) {
        return Promise.resolve(null)
      }
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getCurrentMainWindow, targetId, kind, detail, echo, signal)
    },
    onStateChange: handleSshConnectionStateChange
  }
}
