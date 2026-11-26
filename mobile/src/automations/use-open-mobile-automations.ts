import { useCallback } from 'react'
import {
  hostStackRouteHref,
  type HostStackRouteHref,
  type HostStackRouteTarget
} from '../navigation/host-stack-navigation'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'

/** `create` opens the page straight into a new automation's editor, `automation` on that one's
 *  runs; `server` picks the server they live on instead of the paired host. */
export type AutomationsPageOptions = { create?: boolean; automation?: string; server?: string }

function automationsPageRoute(
  hostId: string,
  options: AutomationsPageOptions = {}
): HostStackRouteTarget {
  return {
    name: '[hostId]/automations',
    params: {
      hostId,
      ...(options.create ? { new: '1' } : {}),
      ...(options.automation ? { automation: options.automation } : {}),
      ...(options.server ? { server: options.server } : {})
    }
  }
}

export function automationsPageHref(
  hostId: string,
  options?: AutomationsPageOptions
): HostStackRouteHref {
  return hostStackRouteHref(automationsPageRoute(hostId, options))
}

export function useOpenMobileAutomations(): (
  hostId: string,
  options?: AutomationsPageOptions
) => void {
  const openHostStackRoute = useOpenHostStackRoute()
  return useCallback(
    (hostId, options) => openHostStackRoute(hostId, automationsPageRoute(hostId, options)),
    [openHostStackRoute]
  )
}
