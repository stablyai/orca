import { createContext, useContext, type ReactNode } from 'react'
import type { HostStatusGates } from '../transport/host-status-gates'

const HostStatusGatesContext = createContext<HostStatusGates | null>(null)

export function HostProtocolGatesProvider({
  value,
  children
}: {
  value: HostStatusGates
  children: ReactNode
}) {
  return <HostStatusGatesContext.Provider value={value}>{children}</HostStatusGatesContext.Provider>
}

export function useHostProtocolGates(): HostStatusGates {
  const gates = useContext(HostStatusGatesContext)
  if (!gates) {
    throw new Error('useHostProtocolGates must be used inside <HostProtocolGate>')
  }
  return gates
}
