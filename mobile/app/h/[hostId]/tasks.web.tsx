import { MobileTasksScreen } from '../../../src/tasks/MobileTasksScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default function MobileTasksRoute() {
  return <MobileTasksScreen />
}
