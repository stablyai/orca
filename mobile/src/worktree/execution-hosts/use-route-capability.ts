import { useHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { useRouteRelaysCapability } from './workspace-server-context'

/** The route's host has the capability; a relayed route also needs the paired desktop to forward it. */
export function useRouteCapability(capability: string): boolean {
  const { hostCapabilities } = useHostProtocolGates()
  const relayed = useRouteRelaysCapability(capability)
  return hostCapabilities.includes(capability) && relayed
}
