import { BRIDGE_COMMANDER_HANDOFF_ROUTE_GRANT } from '../mobile-web-shell/bridge/protocol/bridge-frame-fields'
import { usePageBridgeClientIfPresent } from '../transport/connection/client-context.web'

// A desktop can update its page bundle before the paired phone updates its native shell.
export function useCommanderHandoffRoute(): boolean {
  return (
    usePageBridgeClientIfPresent()
      ?.getShellSession()
      ?.grants.native.includes(BRIDGE_COMMANDER_HANDOFF_ROUTE_GRANT) === true
  )
}
