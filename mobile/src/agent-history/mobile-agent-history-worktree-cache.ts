import { getCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import type { Worktree } from '../worktree/workspace-list-types'

// Module-level in-memory cache preserved across panel unmount/remount so
// Agent History opens instantly (0ms frame-0 paint) on warm re-entry without
// stalling behind worktreeCatalogRead RPC or 30s TTL expiry.
const panelWorktreeCache = new Map<string, Worktree[]>()

export function clearMobileAgentHistoryPanelWorktreeCache(): void {
  panelWorktreeCache.clear()
}

export function readInitialMobileAgentHistoryWorktrees(hostId: string): Worktree[] {
  const inMemory = panelWorktreeCache.get(hostId)
  if (inMemory && inMemory.length > 0) {
    return inMemory
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getCachedWorktrees returns unknown[] of Worktree rows
  const fromVault = getCachedWorktrees(hostId) as Worktree[] | null
  if (fromVault && fromVault.length > 0) {
    panelWorktreeCache.set(hostId, fromVault)
    return fromVault
  }
  return []
}

export function recordMobileAgentHistoryPanelWorktrees(hostId: string, worktrees: Worktree[]): void {
  panelWorktreeCache.set(hostId, worktrees)
  setCachedWorktrees(hostId, worktrees, { proven: true })
}
