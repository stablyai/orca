import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { useLocalSearchParams } from 'expo-router'
import { MobileSourceControlPanel } from '../../../../src/source-control/MobileSourceControlPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { parseSourceControlHubTab } from '../../../../src/source-control/mobile-source-control-hub-tab'
import { useSessionDiffOpenHandlers } from '../../../../src/session/session-diff-open-handlers'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default withWorkspaceRoute(function MobileSourceControlScreen() {
  // Match native firstParam handling even though init.route.params currently guarantees strings.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
    tab?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const origin = firstParam(params.origin)
  const sessionHandlers = useSessionDiffOpenHandlers(hostId, worktreeId)
  return (
    <MobileSourceControlPanel
      hostId={hostId}
      worktreeId={worktreeId}
      name={firstParam(params.name)}
      origin={origin}
      initialTab={parseSourceControlHubTab(firstParam(params.tab))}
      embedded={false}
      {...(origin === 'session' ? sessionHandlers : undefined)}
    />
  )
})
