import { useCallback } from 'react'
import {
  hostStackRouteHref,
  type HostStackRouteHref,
  type HostStackRouteTarget
} from '../navigation/host-stack-navigation'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'

/** `create` opens the page straight into a new automation's editor. */
export type AutomationsPageOptions = { create?: boolean }

function automationsPageRoute(
  hostId: string,
  options: AutomationsPageOptions = {}
): HostStackRouteTarget {
  return {
    name: '[hostId]/automations',
    params: options.create ? { hostId, new: '1' } : { hostId }
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
