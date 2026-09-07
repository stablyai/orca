import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { HostScreenView } from '../../../src/host-screen/host-screen-view'
import {
  type HostScreenProps,
  useHostScreenController
} from '../../../src/host-screen/use-host-screen-controller'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'

export function HostScreen(props: HostScreenProps = {}) {
  const controller = useHostScreenController(props)
  return <HostScreenView controller={controller} />
}

// On wide layouts the sidebar hosts the list, so this route is just the empty detail pane.
export default function HostWorktreeRoute() {
  const { isWideLayout } = useResponsiveLayout()
  if (isWideLayout) {
    return <WorkspaceDetailPlaceholder />
  }
  return <HostScreen />
}
