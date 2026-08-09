import { useEffect } from 'react'
import { startAiVaultTabTitleSync } from '@/lib/ai-vault-tab-title-sync'
import { useAppStore } from '@/store'

export function AiVaultTabTitleSyncGate(): null {
  useEffect(
    () =>
      startAiVaultTabTitleSync({
        getState: useAppStore.getState,
        subscribe: useAppStore.subscribe,
        listSessions: (args) => window.api.aiVault.listSessions(args)
      }),
    []
  )
  return null
}
