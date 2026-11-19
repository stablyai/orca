import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { MobileSessionRouteScreen } from '../../../../src/session/MobileSessionRouteScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default withWorkspaceRoute(function MobileSessionScreen() {
  return <MobileSessionRouteScreen />
})
