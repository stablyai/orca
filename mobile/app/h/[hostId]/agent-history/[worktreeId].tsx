import { MobileAgentSessionHistoryPanel } from '../../../../src/agent-history/MobileAgentSessionHistoryPanel'
import { useMobileWebRouteParams } from '../../../../src/mobile-web/use-mobile-web-route-params'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'

export default function MobileAgentSessionHistoryScreen() {
  const params = useMobileWebRouteParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  return (
    <MobileAgentSessionHistoryPanel
      hostId={firstParam(params.hostId)}
      worktreeId={firstParam(params.worktreeId)}
      name={firstParam(params.name)}
    />
  )
}
