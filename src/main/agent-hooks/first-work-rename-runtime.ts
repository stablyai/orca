import { existsSync } from 'node:fs'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import { rememberBranchRenameFailureOutput } from './branch-rename-failure-output'
import { renameWorktreeFolderOnFirstWork } from './first-work-folder-rename'
import { moveWorktree } from '../git/worktree'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const ENABLE_FIRST_WORK_FOLDER_RENAME = false

export function firstWorkRenameDeps(
  store: Store,
  runtime: Pick<
    OrcaRuntimeService,
    | 'getCommitMessageAgentEnvironmentResolvers'
    | 'notifyFolderWorkspaceChanged'
    | 'notifyBranchRenamed'
    | 'notifyWorktreeFolderRenamed'
  >
): FirstWorkBranchRenameDeps {
  return {
    getSettings: () => store.getSettings(),
    getRepo: (repoId) => store.getRepo(repoId),
    getAgentEnvResolvers: () => runtime.getCommitMessageAgentEnvironmentResolvers(),
    getCurrentDisplayName: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      return scope?.type === 'folder'
        ? store.getFolderWorkspace(scope.folderWorkspaceId)?.name
        : store.getWorktreeMeta(worktreeId)?.displayName
    },
    getFolderWorkspacePath: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      return scope?.type === 'folder'
        ? store.getFolderWorkspace(scope.folderWorkspaceId)?.folderPath
        : undefined
    },
    isPendingFirstAgentMessageRename: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      return scope?.type === 'folder'
        ? store.getFolderWorkspace(scope.folderWorkspaceId)?.pendingFirstAgentMessageRename === true
        : store.getWorktreeMeta(worktreeId)?.pendingFirstAgentMessageRename === true
    },
    canRenameOrcaCreatedBranch: (worktreeId) => {
      const meta = store.getWorktreeMeta(worktreeId)
      // Why: a user branch could coincidentally match a creature name; only Orca-stamped worktrees are safe to auto-rename.
      return !!meta?.orcaCreationSource && meta.preserveBranchOnDelete !== true
    },
    setDisplayName: (worktreeId, displayName) => {
      rememberBranchRenameFailureOutput(worktreeId, null)
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        store.updateFolderWorkspace(scope.folderWorkspaceId, {
          name: displayName,
          pendingFirstAgentMessageRename: false,
          firstAgentMessageRenameError: null
        })
        runtime.notifyFolderWorkspaceChanged()
        return
      }
      store.setWorktreeMeta(worktreeId, {
        displayName,
        // The first-agent title is an intentional user-facing label; keep it stable after the
        // generated branch is renamed and across subsequent catalog refreshes.
        displayNameIsPinned: true,
        pendingFirstAgentMessageRename: false,
        // Success clears the failure badge (redundant with the explicit setRenameError(null)).
        firstAgentMessageRenameError: null
      })
    },
    renameWorktreeFolder: ENABLE_FIRST_WORK_FOLDER_RENAME
      ? (worktreeId, newLeaf) =>
          renameWorktreeFolderOnFirstWork(worktreeId, newLeaf, {
            getRepo: (repoId) => store.getRepo(repoId),
            getSettings: () => store.getSettings(),
            migrateWorktreeIdentity: (oldId, newId) => store.migrateWorktreeIdentity(oldId, newId),
            notifyWorktreeRenamed: (repoId, oldId, newId) =>
              runtime.notifyWorktreeFolderRenamed(repoId, oldId, newId),
            pathExists: async (candidate) => existsSync(candidate),
            moveWorktree
          })
      : undefined,
    setRenameError: (worktreeId, error, failureOutput) => {
      // Refresh the full-output capture before the dedupe below — a repeat error string is still a fresh run.
      rememberBranchRenameFailureOutput(worktreeId, error === null ? null : failureOutput)
      // Skip the write + push when unchanged — most settled worktrees never had an error to clear.
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        const current = store.getFolderWorkspace(
          scope.folderWorkspaceId
        )?.firstAgentMessageRenameError
        if ((current ?? null) === (error ?? null)) {
          return
        }
        store.updateFolderWorkspace(scope.folderWorkspaceId, {
          firstAgentMessageRenameError: error
        })
        runtime.notifyFolderWorkspaceChanged()
        return
      }
      const current = store.getWorktreeMeta(worktreeId)?.firstAgentMessageRenameError
      if ((current ?? null) === (error ?? null)) {
        return
      }
      store.setWorktreeMeta(worktreeId, { firstAgentMessageRenameError: error })
      // Why: the hook only knows the worktreeId, so derive the repoId notifyBranchRenamed expects.
      runtime.notifyBranchRenamed(getRepoIdFromWorktreeId(worktreeId))
    },
    resolveWorktreeIdForTab: (tabId) => store.getWorktreeIdForTab(tabId),
    onRenamed: (repoIdOrWorktreeId) => {
      if (parseWorkspaceKey(repoIdOrWorktreeId)?.type === 'folder') {
        runtime.notifyFolderWorkspaceChanged()
        return
      }
      runtime.notifyBranchRenamed(repoIdOrWorktreeId)
    }
  }
}
