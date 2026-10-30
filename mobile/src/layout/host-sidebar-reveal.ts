import { createContext, useContext } from 'react'

// Expose Show sidebar only while the wide layout hides its sidebar; the hidden sidebar’s own toggle is unreachable. Detail pages beside a native sidebar leave this null.
export const HostSidebarRevealContext = createContext<(() => void) | null>(null)

export function useHostSidebarReveal(): (() => void) | null {
  return useContext(HostSidebarRevealContext)
}
