import {
  useHostProtocolGates,
  useOptionalHostProtocolGates
} from '../../components/host-connection/host-protocol-gates-context'
import { useRouteRelaysCapability } from './workspace-server-context'

/** The route's host has the capability; a relayed route also needs the paired desktop to forward it. */
export function useRouteCapability(capability: string): boolean {
  const { hostCapabilities } = useHostProtocolGates()
  const relayed = useRouteRelaysCapability(capability)
  return hostCapabilities.includes(capability) && relayed
}

/** As useRouteCapability, but false for a screen mounted outside a host route (as the recorder mounts one). */
export function useOptionalRouteCapability(capability: string): boolean {
  const gates = useOptionalHostProtocolGates()
  const relayed = useRouteRelaysCapability(capability)
  return (gates?.hostCapabilities.includes(capability) ?? false) && relayed
}
