import { AgentcookieSessionSync } from '../browser/agentcookie-session-sync'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import { mainProcessState as state } from './main-process-state'

// Inert when agentcookie is not installed or the setting is off.
export function startAgentcookieSessionSync(): void {
  const settingsStore = state.store
  if (state.agentcookieSync || !settingsStore) {
    return
  }
  state.agentcookieSync = new AgentcookieSessionSync({
    targetPartition: ORCA_BROWSER_PARTITION,
    isEnabled: () => settingsStore.getSettings().agentcookieSyncEnabled !== false,
    onStatus: (status) => {
      settingsStore.updateSettings({
        agentcookieDetected: status.detected,
        ...(status.lastSyncAt !== null ? { agentcookieLastSyncAt: status.lastSyncAt } : {}),
        ...(status.lastImportedCount !== null
          ? { agentcookieLastImportedCount: status.lastImportedCount }
          : {})
      })
    }
  })
  state.agentcookieSync.start()
}
