import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { MobileSessionRouteScreen } from '../../../../src/session/MobileSessionRouteScreen'

/**
 * The page's route for the session screen: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default withWorkspaceRoute(function MobileSessionScreen() {
  return <MobileSessionRouteScreen />
})
