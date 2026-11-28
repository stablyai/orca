import { MobileResourcesScreen } from '../../../src/resources/MobileResourcesScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default function MobileResourcesRoute() {
  return <MobileResourcesScreen />
}
