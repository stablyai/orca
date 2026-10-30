import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { HostScreen } from '../../../src/host-screen/HostScreen'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'
import { usePageOwnsHostArea } from '../../../src/mobile-web-shell/page-owns-host-area'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default function HostWorktreeRoute() {
  // The placeholder only beside the page's own sidebar: without the host area this is the list.
  const ownsHostArea = usePageOwnsHostArea()
  const { isWideLayout } = useResponsiveLayout()
  return ownsHostArea && isWideLayout ? <WorkspaceDetailPlaceholder /> : <HostScreen />
}
