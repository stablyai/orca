import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { HostScreen } from '../../../src/host-screen/HostScreen'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'

/**
 * Web sibling for the worktree list.
 *
 * This page is what the shell renders for this route, so there is no shell to mount here and no
 * flag to read: the switch already happened natively. Its native file also reaches
 * OrcaMobileWebShellView, whose module calls requireNativeViewManager at import and throws in a
 * browser, and one throwing route module takes the whole bundle down because the manifest imports
 * them all.
 */
export default function HostWorktreeRoute() {
  const { isWideLayout } = useResponsiveLayout()
  if (isWideLayout) {
    return <WorkspaceDetailPlaceholder />
  }
  return <HostScreen />
}
