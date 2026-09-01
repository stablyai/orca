import { useSyncExternalStore } from 'react'
import { agentCatalogSync, type AgentCatalogValue } from '../transport/agent-catalog-sync'

const NO_OP_UNSUBSCRIBE = () => {}

// Why: the picker mirrors the host's env-free synced catalog. agentCatalogSync caches
// the revisioned value per host (mounted app-wide in client-context) and returns a
// stable reference until it changes, so useSyncExternalStore re-renders only on real
// revision changes without re-fetching here.
export function useAgentCatalogSnapshot(
  hostId: string | null | undefined
): AgentCatalogValue | null {
  return useSyncExternalStore(
    (onChange) => (hostId ? agentCatalogSync.subscribe(hostId, onChange) : NO_OP_UNSUBSCRIBE),
    () => (hostId ? agentCatalogSync.getSnapshot(hostId) : null)
  )
}
