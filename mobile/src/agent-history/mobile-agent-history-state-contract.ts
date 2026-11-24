import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import type { MobileAiVaultProjectSetup } from './agent-history-scope-paths'

export type MobileAgentHistoryStateParams = {
  hostId: string
  worktreeId: string
  conversationId?: string
  worktrees: readonly Worktree[]
  // Distinguish unfetched worktree list from fetched-but-missing workspace; only first holds loading.
  worktreesLoaded: boolean
  projectSetups?: readonly MobileAiVaultProjectSetup[]
}
