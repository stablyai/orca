import { useLocalSearchParams } from 'expo-router'
import { MobileSourceControlPanel } from '../../../../src/source-control/MobileSourceControlPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { parseSourceControlHubTab } from '../../../../src/source-control/mobile-source-control-hub-tab'

/**
 * Web sibling for the source-control hub.
 *
 * This page is what the shell renders for this route, so there is no shell to mount here and no
 * flag to read: the switch already happened natively. Its native file also reaches
 * OrcaMobileWebShellView, whose module calls requireNativeViewManager at import and throws in a
 * browser, and the route manifest imports every route — one throwing module takes the bundle down.
 */
export default function MobileSourceControlScreen() {
  // Through `firstParam`, as the native sibling does. The page reaches this route only through
  // `init.route`, whose params are a `Record<string, string>`, so an array cannot arrive today —
  // read the same way regardless, because the two files are meant to be the same screen and a
  // difference between them is a difference nobody would look for.
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
}
