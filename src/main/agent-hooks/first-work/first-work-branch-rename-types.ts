import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { Repo } from '../../../shared/repository/repo-types'
import type { getConfiguredBranchPrefix } from '../../ipc/worktrees/creation/worktree-branch-name'
import type { resolveCommitMessageSettings as resolveTextGenerationParams } from '../../text-generation/commit-message-text-generation'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import type { AgentGenerationFailureOutput } from '../../text-generation/failures/agent-failure-output'
import type { FirstWorkAttemptDeps } from './first-work-rename-attempts'

export type FirstWorkBranchRenameDeps = FirstWorkAttemptDeps & {
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
