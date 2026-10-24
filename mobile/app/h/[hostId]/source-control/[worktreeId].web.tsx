import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { useLocalSearchParams } from 'expo-router'
import { MobileSourceControlPanel } from '../../../../src/source-control/MobileSourceControlPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { parseSourceControlHubTab } from '../../../../src/source-control/mobile-source-control-hub-tab'

/**
 * The page's route for the source-control hub: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default withWorkspaceRoute(function MobileSourceControlScreen() {
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
})
