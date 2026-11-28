import { createContext, type ReactNode } from 'react'

export const SessionListLongPressContext = createContext<(() => void) | null>(null)

// Session screens replace the root dismiss with the draft leave request.
export function SessionListLongPressOverride({
  action,
  children
}: {
  action: (() => void) | null
  children: ReactNode
}) {
  return (
    <SessionListLongPressContext.Provider value={action}>
      {children}
    </SessionListLongPressContext.Provider>
  )
}
