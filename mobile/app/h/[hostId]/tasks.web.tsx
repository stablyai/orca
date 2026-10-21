import { MobileTasksScreen } from '../../../src/tasks/MobileTasksScreen'

/**
 * The page's route for the tasks screen: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default function MobileTasksRoute() {
  return <MobileTasksScreen />
}
