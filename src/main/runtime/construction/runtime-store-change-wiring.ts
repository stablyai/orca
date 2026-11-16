import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { RuntimeStore } from './runtime-store-contract'
import { publishNativeChatPreferenceChanges } from '../agent-session/launch/runtime-native-chat-preference-events'
import { publishSettingsChanges } from '../client/settings/runtime-settings-change-events'
import { publishWorkspaceViewChanges } from '../client/settings/runtime-workspace-view-change-events'
import { syncPRAutoRefreshCadence } from '../../github/pull-requests/refresh/pr-auto-refresh-cadence-sync'
import { registerWorktreeCatalogRoutes } from '../workspaces/catalog/worktree-catalog-live-route'

/** Subscribe the runtime's store-driven routes, client change events, and PR refresh cadence. */
export function wireRuntimeStoreChanges(
  store: RuntimeStore | null,
  emit: (event: RuntimeClientEvent) => void
): void {
  registerWorktreeCatalogRoutes(store)
  publishWorkspaceViewChanges(store, emit)
  publishNativeChatPreferenceChanges(store, emit)
  publishSettingsChanges(store, emit)
  syncPRAutoRefreshCadence(store)
}
