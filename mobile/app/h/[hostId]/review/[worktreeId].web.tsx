import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { MobileDiffReviewRouteScreen } from '../../../../src/session/MobileDiffReviewRouteScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default withWorkspaceRoute(function MobileDiffReviewScreen() {
  return <MobileDiffReviewRouteScreen />
})
