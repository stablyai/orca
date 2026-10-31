import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { MobileCommitDetailRouteScreen } from '../../../../src/source-control/MobileCommitDetailRouteScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default withWorkspaceRoute(function MobileCommitDetailScreen() {
  return <MobileCommitDetailRouteScreen />
})
