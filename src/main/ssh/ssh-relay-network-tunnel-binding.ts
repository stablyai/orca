import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshConnection } from './ssh-connection'
import type { SshPtyConsumerOwnerState } from './ssh-pty-consumer-session'

export type SshNetworkTunnelSessionSnapshot = {
  mux: SshChannelMultiplexer
  connection: SshConnection
  providerGeneration: number
  owner: SshPtyConsumerOwnerState
  resetPending: boolean
}

/** Reset closes new admission, but admitted traffic keeps its exact authority while draining. */
export function captureSshNetworkTunnelBinding(
  readSession: () => SshNetworkTunnelSessionSnapshot | null
) {
  const captured = readSession()
  if (!captured || captured.resetPending) {
    throw new Error('ssh_network_tunnel_session_unavailable')
  }
  const { mux, connection, providerGeneration } = captured
  const owner = Object.freeze({ ...captured.owner })
  const sourceChannel = mux.getSourceChannel()
  const assertCurrent = () => {
    const current = readSession()
    if (
      !current ||
      current.mux !== mux ||
      current.connection !== connection ||
      current.providerGeneration !== providerGeneration ||
      connection.getState().status !== 'connected' ||
      mux.isDisposed() ||
      mux.getSourceChannel() !== sourceChannel ||
      current.owner.clientInstanceId !== owner.clientInstanceId ||
      current.owner.clientGeneration !== owner.clientGeneration ||
      current.owner.ownerGeneration !== owner.ownerGeneration ||
      current.owner.ownerLease !== owner.ownerLease
    ) {
      throw new Error('ssh_network_tunnel_session_changed')
    }
    mux.assertWriteSettlement()
  }
  const assertAdmission = () => {
    assertCurrent()
    if (readSession()?.resetPending !== false) {
      throw new Error('ssh_network_tunnel_admission_closed')
    }
  }
  assertAdmission()
  return { mux, connection, providerGeneration, owner, assertCurrent, assertAdmission }
}
