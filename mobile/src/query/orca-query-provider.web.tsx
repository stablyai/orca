import type { ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'

// One client per page document, made at boot so stored data is in it before the first render.
// TanStack's own visibilitychange listener drives foreground revalidation.
export function OrcaQueryProvider({
  client,
  children
}: {
  client: QueryClient
  children: ReactNode
}) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
