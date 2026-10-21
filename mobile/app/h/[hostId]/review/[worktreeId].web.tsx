import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { MobileDiffReviewRouteScreen } from '../../../../src/session/MobileDiffReviewRouteScreen'

/**
 * The page's route for diff review: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default withWorkspaceRoute(function MobileDiffReviewScreen() {
  return <MobileDiffReviewRouteScreen />
})
