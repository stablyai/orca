import type { SshBridgeCallerScope } from '../runtime/rpc/ssh-bridge-credentials'

/** A bridged SSH CLI whose host the user opted in to control Orca, i.e. the pre-scope behaviour. */
export const CONTROL_GRANTED_SSH_BRIDGE_SCOPE: SshBridgeCallerScope = {
  kind: 'ssh-bridge',
  targetId: 'box-1',
  remoteCliControl: true
}

/** The default bridge: reaches only that host's own terminals. */
export const HOST_BOUND_SSH_BRIDGE_SCOPE: SshBridgeCallerScope = {
  kind: 'ssh-bridge',
  targetId: 'box-1',
  remoteCliControl: false
}
