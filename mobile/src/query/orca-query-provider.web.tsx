import { useState, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createOrcaQueryClient } from './orca-query-client'

// One client per page document; TanStack's own visibilitychange listener drives foreground revalidation.
export function OrcaQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createOrcaQueryClient)
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
