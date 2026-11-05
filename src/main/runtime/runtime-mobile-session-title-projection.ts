import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

export function projectRuntimeMobileSessionTitle(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tab: RuntimeMobileSessionTerminalTab,
  host: RuntimeMobileSessionProjectionHost
) {
  // Retained names are caches; only their current publisher may authoritatively clear them.
  return host.isSessionTitlePublisher(snapshot.worktree, tab.id)
    ? { aiVaultTitle: tab.aiVaultTitle ?? null, resolvesSessionTitle: true as const }
    : tab.aiVaultTitle
      ? { aiVaultTitle: tab.aiVaultTitle }
      : {}
}
