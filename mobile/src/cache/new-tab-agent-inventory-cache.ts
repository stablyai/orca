import type { MobileNewTabAgentInventory } from '../session/mobile-new-tab-agent-loader'

// Reuse settled agent detection per paired host and host-qualified workspace; installs rarely change, matching desktop inventory.

const cache = new Map<string, MobileNewTabAgentInventory>()

const MAX_ENTRIES = 50

function cacheKey(hostId: string, workspaceKey: string): string {
  return `${hostId}\u0000${workspaceKey}`
}

export function setCachedNewTabAgentInventory(
  hostId: string,
  workspaceKey: string,
  inventory: MobileNewTabAgentInventory
): void {
  const key = cacheKey(hostId, workspaceKey)
  cache.delete(key)
  cache.set(key, inventory)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) {
      cache.delete(oldest)
    }
  }
}

export function getCachedNewTabAgentInventory(
  hostId: string,
  workspaceKey: string
): MobileNewTabAgentInventory | null {
  return cache.get(cacheKey(hostId, workspaceKey)) ?? null
}

export function deleteCachedNewTabAgentInventory(hostId: string, workspaceKey: string): void {
  cache.delete(cacheKey(hostId, workspaceKey))
}
