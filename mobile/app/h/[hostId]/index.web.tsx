import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { HostScreen } from '../../../src/host-screen/HostScreen'
import { usePageOwnsHostArea } from '../../../src/mobile-web-shell/page-owns-host-area'

/**
 * The page's route for the worktree list: the screen itself. The native route file mounts the shell, whose
 * native view module throws at import in a browser, and the manifest imports every route.
 */
export default function HostWorktreeRoute() {
  // The placeholder only beside the page's own sidebar: without the host area this is the list.
  return usePageOwnsHostArea() ? <WorkspaceDetailPlaceholder /> : <HostScreen />
}
