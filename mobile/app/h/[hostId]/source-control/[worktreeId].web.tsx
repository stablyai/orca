import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { useLocalSearchParams } from 'expo-router'
import { MobileSourceControlPanel } from '../../../../src/source-control/MobileSourceControlPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { parseSourceControlHubTab } from '../../../../src/source-control/mobile-source-control-hub-tab'

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
  return (
    <MobileSourceControlPanel
      hostId={firstParam(params.hostId)}
      worktreeId={firstParam(params.worktreeId)}
      name={firstParam(params.name)}
      origin={firstParam(params.origin)}
      initialTab={parseSourceControlHubTab(firstParam(params.tab))}
      embedded={false}
    />
  )
})
