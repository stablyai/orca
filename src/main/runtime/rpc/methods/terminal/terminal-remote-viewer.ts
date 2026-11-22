import type { RpcContext } from '../../core'
import type { RemoteTerminalViewer } from '../../../terminal/layout/terminal-view-presence'
import { TERMINAL_HOST_PANE_RESPAWN_CLIENT_CAPABILITY } from '../../../../../shared/terminal/pty/lifecycle/host-pane-respawn-capability'

export function remoteTerminalViewer(
  deviceId: string | undefined,
  capabilities: RpcContext['clientCapabilities']
): RemoteTerminalViewer {
  return {
    deviceId,
    followsHostRespawn:
      capabilities?.includes(TERMINAL_HOST_PANE_RESPAWN_CLIENT_CAPABILITY) === true
  }
}
