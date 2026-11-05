import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

export function projectRuntimeMobileSessionTitle(
  snapshot: Pick<RuntimeMobileSessionTabsSnapshot, 'worktree'>,
  tab: RuntimeMobileSessionTerminalTab,
  host: Pick<RuntimeMobileSessionProjectionHost, 'isSessionTitlePublisher'>
) {
  // A paired desktop re-ranks these itself, so the quick-command name must travel with the session name.
  const quickCommandLabel = tab.quickCommandLabel?.trim()
  return {
    ...(quickCommandLabel ? { quickCommandLabel } : {}),
    // Retained names are caches; only their current publisher may authoritatively clear them.
    ...(host.isSessionTitlePublisher(snapshot.worktree, tab.id)
      ? { aiVaultTitle: tab.aiVaultTitle ?? null, resolvesSessionTitle: true as const }
      : tab.aiVaultTitle
        ? { aiVaultTitle: tab.aiVaultTitle }
        : {})
  }
}
