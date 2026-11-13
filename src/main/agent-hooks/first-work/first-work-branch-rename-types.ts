import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import type { getConfiguredBranchPrefix } from '../../ipc/worktree-branch-name'
import type { resolveCommitMessageSettings as resolveTextGenerationParams } from '../../text-generation/commit-message-text-generation'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import type { AgentGenerationFailureOutput } from '../../text-generation/failures/agent-failure-output'

export type FirstWorkBranchRenameEvent = {
  paneKey: string
  /** Untrusted agent echo; use only as a fallback. */
  worktreeId: string | undefined
  tabId: string | undefined
  state: string
  prompt: string | undefined
  assistantMessage: string | undefined
  isReplay: boolean | undefined
}

export type FirstWorkBranchRenameDeps = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0] &
    Parameters<typeof getConfiguredBranchPrefix>[0] &
    Partial<
      Pick<GlobalSettings, 'autoRenameBranchFromWork' | 'workspaceTitleLanguage' | 'uiLanguage'>
    >
  getRepo: (repoId: string) => Repo | undefined
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
  getCurrentDisplayName: (worktreeId: string) => string | undefined
  getFolderWorkspacePath?: (worktreeId: string) => string | undefined
  isFolderWorkspaceWslMoveBlocked?: (worktreeId: string) => boolean
  isPendingFirstAgentMessageRename?: (worktreeId: string) => boolean
  /** Require Orca creation provenance before renaming a branch. */
  canRenameOrcaCreatedBranch: (worktreeId: string) => boolean
  setDisplayName: (worktreeId: string, displayName: string) => void
  /** Best-effort local folder alignment after the branch rename. */
  renameWorktreeFolder?: (worktreeId: string, newLeaf: string) => Promise<boolean>
  /** Null clears the badge; failureOutput supplies bounded local diagnostics. */
  setRenameError: (
    worktreeId: string,
    error: string | null,
    failureOutput?: AgentGenerationFailureOutput | null
  ) => void
  resolveWorktreeIdForTab: (tabId: string) => string | undefined
  onRenamed: (repoId: string) => void
}
