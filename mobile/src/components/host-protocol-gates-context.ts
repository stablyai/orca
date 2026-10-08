import { createContext, useContext } from 'react'
import type { HostStatusGates } from '../transport/host-status-gates'

// Apart from the gate screen so a workspace's client can read capabilities without its UI.
export const HostStatusGatesContext = createContext<HostStatusGates | null>(null)

/** The gates, or null outside a host route (a screen mounted on its own, as the recorder does). */
export function useOptionalHostProtocolGates(): HostStatusGates | null {
  return useContext(HostStatusGatesContext)
}
