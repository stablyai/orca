import type { MobileSessionController } from '../use-mobile-session-controller'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileAgentMapView } from './MobileAgentMapView'

/** Mounts the live agent map over the session while the active tab is in map view. */
export function MobileAgentMapOverlay(args: {
  controller: MobileSessionController
  client: RpcClient | null
}): React.JSX.Element | null {
  const { controller, client } = args
  const agentMap = controller.agentMap
  const tab = controller.activeSessionTab
  if (!agentMap.showAgentMap || tab?.id == null) {
    return null
  }
  return (
    <MobileAgentMapView
      // A session change must remount the view: the previous session's scrub
      // position and node selection must not apply to the new one.
      key={JSON.stringify([tab.id, agentMap.activeMapSessionId])}
      client={client}
      connected={controller.connState === 'connected'}
      agent={tab.type === 'agent-session' ? tab.agent : null}
      sessionId={agentMap.activeMapSessionId}
      sourceIdentity={agentMap.sourceIdentity}
      onClose={() => agentMap.setTabView(tab.id, 'terminal')}
    />
  )
}
