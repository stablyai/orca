import { createContext, useContext } from 'react'

// Set by the wide host layout while the sidebar it draws is hidden; null otherwise,
// including a page in the detail pane beside the native sidebar. Detail headers
// render a "Show sidebar" button from it, since the hide button goes away with the
// sidebar it lives in.
export const HostSidebarRevealContext = createContext<(() => void) | null>(null)

export function useHostSidebarReveal(): (() => void) | null {
  return useContext(HostSidebarRevealContext)
}
