import { getAgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type { CatalogModel } from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import { clearMobileNativeChatAppliedReport } from './mobile-native-chat-applied-report'

export type MobileDiscoveredModelEntry = {
  agent: string
  models: readonly CatalogModel[] | null
  /** True after the picker hid a discovered catalog and the refresh has not settled. */
  awaitingRefresh: boolean
  surface: {
    replaceModels(models: readonly CatalogModel[], dropUnlistedSelection?: boolean): void
  }
}

/**
 * Hide a stale discovered catalog while a refresh is in flight, and only drop the tracked
 * route once the refresh settles. Success keeps a route the fresh catalog still lists.
 * Failure drops a discovered route that the seeded catalog does not list.
 */
export function syncMobileDiscoveredModels(
  entry: MobileDiscoveredModelEntry,
  discoveredModels: readonly CatalogModel[] | null | undefined,
  discoveryFailed: boolean,
  scopeKey: string | null
): void {
  if (discoveredModels && !discoveryFailed) {
    entry.awaitingRefresh = false
    if (entry.models !== discoveredModels) {
      entry.models = discoveredModels
      entry.surface.replaceModels(discoveredModels, true)
    }
    return
  }
  if (discoveryFailed) {
    entry.awaitingRefresh = false
    entry.models = null
    entry.surface.replaceModels(getAgentSessionOptionCatalog(entry.agent)?.models ?? [], true)
    return
  }
  if (!entry.models) {
    return
  }
  entry.awaitingRefresh = true
  entry.models = null
  const seeded = getAgentSessionOptionCatalog(entry.agent)?.models
  if (seeded) {
    entry.surface.replaceModels([...seeded], false)
  }
  if (scopeKey) {
    clearMobileNativeChatAppliedReport(scopeKey)
  }
}
