import { useEffect } from 'react'
import { startAiVaultTabTitleSync } from '@/lib/ai-vault-tab-title-sync'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import { useAppStore } from '@/store'
import { projectCachedAiVaultStructuredTitles } from './right-sidebar/ai-vault-session-result-cache'
import { aiVaultStructuredTitlesChanged } from './right-sidebar/ai-vault-structured-title-projection'

const TITLE_SYNC_DELAY_MS = 1_000
const TITLE_SYNC_QUIET_MS = 1_500
const TITLE_SYNC_IDLE_TIMEOUT_MS = 3_000

export function AiVaultTabTitleSyncGate(): null {
  useEffect(() => {
    projectCachedAiVaultStructuredTitles(useAppStore.getState().unifiedTabsByWorktree)
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        aiVaultStructuredTitlesChanged(state.unifiedTabsByWorktree, previous.unifiedTabsByWorktree)
      ) {
        projectCachedAiVaultStructuredTitles(state.unifiedTabsByWorktree)
      }
    })
    const stop = startAiVaultTabTitleSync({
      getState: useAppStore.getState,
      subscribe: useAppStore.subscribe,
      resolveSessionTitles: (args) => window.api.aiVault.resolveSessionTitles(args),
      scheduleReconcile: (callback) =>
        scheduleAfterInputQuiet(callback, {
          delayMs: TITLE_SYNC_DELAY_MS,
          quietMs: TITLE_SYNC_QUIET_MS,
          idleTimeoutMs: TITLE_SYNC_IDLE_TIMEOUT_MS
        })
    })
    return () => {
      unsubscribe()
      stop()
    }
  }, [])
  return null
}
