import type { Worktree } from '../worktree/workspace-list-types'

export type MobileAgentHistoryStateParams = {
  hostId: string
  worktreeId: string
  conversationId?: string
  worktrees: readonly Worktree[]
  // Distinguish unfetched worktree list from fetched-but-missing workspace; only first holds loading.
  worktreesLoaded: boolean
}
