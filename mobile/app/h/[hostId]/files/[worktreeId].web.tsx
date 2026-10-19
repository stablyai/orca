import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { useLocalSearchParams } from 'expo-router'
import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'

/**
 * The page's route for the file explorer: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default withWorkspaceRoute(function MobileFileExplorerScreen() {
  // Through `firstParam`, as the native sibling does. The page reaches this route only through
  // `init.route`, whose params are a `Record<string, string>`, so an array cannot arrive today —
  // read the same way regardless, because the two files are meant to be the same screen and a
  // difference between them is a difference nobody would look for.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  return (
    <MobileFileExplorerPanel hostId={hostId} worktreeId={worktreeId} name={name} embedded={false} />
  )
})
