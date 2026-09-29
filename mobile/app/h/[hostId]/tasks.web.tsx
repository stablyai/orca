import { MobileTasksScreen } from '../../../src/tasks/MobileTasksScreen'

/**
 * Web sibling for the tasks screen, in `index.web.tsx`'s shape.
 *
 * This page is what the shell renders for this route, so there is no shell to mount here and no
 * flag to read: the switch already happened natively. Its native file reaches
 * `OrcaMobileWebShellView`, whose module calls `requireNativeViewManager` at import and throws in
 * a browser, and one throwing route module takes the whole bundle down because the manifest
 * imports them all.
 */
export default function MobileTasksRoute() {
  return <MobileTasksScreen />
}
