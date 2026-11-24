import { useEffect, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { focusManager, QueryClientProvider } from '@tanstack/react-query'
import { createOrcaQueryClient } from './orca-query-client'
import { noteAppForegrounded } from './host-read-intent'

// React Native has no visibilitychange, so foreground revalidation follows AppState.
function followAppState(setFocused: (focused?: boolean) => void): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    const active = state === 'active'
    if (active) {
      // The focus refetches that follow are the user looking, not the screen's timer.
      noteAppForegrounded()
    }
    setFocused(active)
  })
  return () => subscription.remove()
}

export function OrcaQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createOrcaQueryClient)
  useEffect(() => focusManager.setEventListener(followAppState), [])
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
