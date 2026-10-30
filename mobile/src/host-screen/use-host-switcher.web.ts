import { useCallback } from 'react'
import type { RouteHandoff } from '../navigation/route-handoff'
import { holdSessionLeave } from '../session/session-leave-guard'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'
import { switchDesktopRoute } from './switch-desktop-route'
import type { HostSwitcher } from './use-host-switcher'

// The shell draws the sheet, so the page's own picker never opens.
const SHELL_OWNED_PICKER: HostSwitcher['pickerProps'] = {
  visible: false,
  options: [],
  selected: '',
  onSelect: () => {},
  onClose: () => {},
  onAfterClose: async () => false
}

// The page knows only its own desktop: the shell says in init whether another exists, and opens its own sheet.
export function useHostSwitcher(
  currentHostId: string | undefined,
  router: Pick<RouteHandoff, 'push'>
): HostSwitcher {
  const session = usePageBridgeClientIfPresent()?.getShellSession()
  // Older shells omit the fact; without navigate the shell would refuse the hop.
  const offered = session?.hostSwitcher === true && session.grants.native.includes('navigate')
  const open = useCallback(() => {
    // The shell's sheet cannot reach this page's session, so ask its hold before leaving for it.
    if (currentHostId !== undefined && !holdSessionLeave()) {
      router.push(switchDesktopRoute(currentHostId))
    }
  }, [currentHostId, router])
  return {
    canSwitch: offered && currentHostId !== undefined,
    loaded: true,
    open,
    pickerProps: SHELL_OWNED_PICKER
  }
}
