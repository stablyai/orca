import { BRIDGE_CHAT_VISUAL_FRAME_GRANT } from '../../../mobile-web-shell/bridge/protocol/bridge-frame-fields'
import { usePageBridgeClientIfPresent } from '../../../transport/connection/client-context.web'

// Read session init grants once at render (entry waits for init; grants are immutable).
export function useMobileNativeChatVisualFrameGrant(): boolean {
  const client = usePageBridgeClientIfPresent()
  return client?.getShellSession()?.grants.native.includes(BRIDGE_CHAT_VISUAL_FRAME_GRANT) === true
}
