import { createContext, useContext, type ReactNode } from 'react'

export type MobilePrShellOperations = {
  selection(): void
  success(): void
  error(): void
  writeClipboard(text: string): Promise<void>
  openExternal(url: string): Promise<void>
}

const MobilePrShellOperationsContext = createContext<MobilePrShellOperations | null>(null)

export function MobilePrShellOperationsProvider({
  operations,
  children
}: {
  operations: MobilePrShellOperations
  children: ReactNode
}) {
  return (
    <MobilePrShellOperationsContext.Provider value={operations}>
      {children}
    </MobilePrShellOperationsContext.Provider>
  )
}

export function useMobilePrShellOperations(): MobilePrShellOperations {
  const operations = useContext(MobilePrShellOperationsContext)
  if (!operations) {
    throw new Error('Mobile PR shell operations are unavailable')
  }
  return operations
}
