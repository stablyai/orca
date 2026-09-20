import { useLocalSearchParams } from 'expo-router'
import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'

/**
 * Web sibling for the file explorer.
 *
 * This page is what the shell renders for this route, so there is no shell to mount here and no
 * flag to read: the switch already happened natively. Its native file also reaches
 * OrcaMobileWebShellView, whose module calls requireNativeViewManager at import and throws in a
 * browser, which is what the page opening this route would hit.
 */
export default function MobileFileExplorerScreen() {
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
}
