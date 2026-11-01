import { createContext, useContext, type ReactNode } from 'react'

const MobileNativeChatOpenSubagentContext = createContext<((agentId: string) => void) | null>(null)

export function useMobileNativeChatOpenSubagent(): ((agentId: string) => void) | null {
  return useContext(MobileNativeChatOpenSubagentContext)
}

export function MobileNativeChatOpenSubagentProvider({
  onOpen,
  children
}: {
  onOpen: (agentId: string | null) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <MobileNativeChatOpenSubagentContext.Provider value={onOpen}>
      {children}
    </MobileNativeChatOpenSubagentContext.Provider>
  )
}
