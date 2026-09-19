import { useLocalSearchParams } from 'expo-router'
import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'

/**
 * Web sibling for the file explorer.
 *
 * This page is what the shell renders for this route, so there is no shell to mount here and no
 * flag to read: the switch already happened natively. Its native file also reaches
 * OrcaMobileWebShellView, whose module calls requireNativeViewManager at import and throws in a
 * browser, which is what the page opening this route would hit.
 */
export default function MobileFileExplorerScreen() {
  const { hostId, worktreeId, name } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
  }>()
  return (
    <MobileFileExplorerPanel hostId={hostId} worktreeId={worktreeId} name={name} embedded={false} />
  )
}
