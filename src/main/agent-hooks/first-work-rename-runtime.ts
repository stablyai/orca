import { existsSync } from 'node:fs'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import { rememberBranchRenameFailureOutput } from './branch-rename-failure-output'
import { renameWorktreeFolderOnFirstWork } from './first-work-folder-rename'
import { moveWorktree } from '../git/worktree'
import { isWslMoveFolderWorkspaceBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'
import type { Store } from '../persistence'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolveWorktreeMetaOwner } from '../persistence/host-qualified-worktree-meta'

const ENABLE_FIRST_WORK_FOLDER_RENAME = false

export function firstWorkRenameDeps(
  store: Pick<
    RuntimeStore,
    | 'getSettings'
    | 'getRepo'
    | 'getRepos'
    | 'getWorktreeMeta'
    | 'setWorktreeMeta'
    | 'getFolderWorkspace'
    | 'updateFolderWorkspace'
  > &
    Partial<Pick<Store, 'migrateWorktreeIdentity' | 'getWorktreeIdForTab'>>,
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
        ? store.getFolderWorkspace!(scope.folderWorkspaceId)?.name
        : store.getWorktreeMeta(worktreeId)?.displayName
    },
    getFolderWorkspacePath: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      return scope?.type === 'folder'
        ? store.getFolderWorkspace!(scope.folderWorkspaceId)?.folderPath
        : undefined
    },
    isFolderWorkspaceWslMoveBlocked: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      const folder =
        scope?.type === 'folder' ? store.getFolderWorkspace!(scope.folderWorkspaceId) : undefined
      return !!folder && isWslMoveFolderWorkspaceBlocked(folder)
    },
    isPendingFirstAgentMessageRename: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      return scope?.type === 'folder'
        ? store.getFolderWorkspace!(scope.folderWorkspaceId)?.pendingFirstAgentMessageRename ===
            true
        : store.getWorktreeMeta(worktreeId)?.pendingFirstAgentMessageRename === true
    },
    canRenameOrcaCreatedBranch: (worktreeId) => {
      const meta = store.getWorktreeMeta(worktreeId)
      // A creature-like name alone cannot prove Orca owns the branch.
      return !!meta?.orcaCreationSource && meta.preserveBranchOnDelete !== true
    },
    setDisplayName: (worktreeId, displayName) => {
      rememberBranchRenameFailureOutput(worktreeId, null)
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        store.updateFolderWorkspace!(scope.folderWorkspaceId, {
          name: displayName,
          pendingFirstAgentMessageRename: false,
          firstAgentMessageRenameError: null
        })
        runtime.notifyFolderWorkspaceChanged()
        return
      }
      const target = resolveWorktreeMetaOwner(store, worktreeId)
      if (!target) {
        return
      }
      store.setWorktreeMeta(target, {
        displayName,
        // Pin the generated title across branch renames and catalog refreshes.
        displayNameIsPinned: true,
        pendingFirstAgentMessageRename: false,
        firstAgentMessageRenameError: null
      })
    },
    renameWorktreeFolder: ENABLE_FIRST_WORK_FOLDER_RENAME
      ? (worktreeId, newLeaf) =>
          renameWorktreeFolderOnFirstWork(worktreeId, newLeaf, {
            getRepo: (repoId) => store.getRepo(repoId),
            getSettings: () => store.getSettings(),
            migrateWorktreeIdentity: (target, newId) =>
              store.migrateWorktreeIdentity!(target, newId),
            notifyWorktreeRenamed: (repoId, oldId, newId) =>
              runtime.notifyWorktreeFolderRenamed(repoId, oldId, newId),
            pathExists: async (candidate) => existsSync(candidate),
            moveWorktree
          })
      : undefined,
    setRenameError: (worktreeId, error, failureOutput) => {
      // Refresh diagnostics before deduping; repeated text can come from a new run.
      rememberBranchRenameFailureOutput(worktreeId, error === null ? null : failureOutput)
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        const current = store.getFolderWorkspace!(
          scope.folderWorkspaceId
        )?.firstAgentMessageRenameError
        if ((current ?? null) === (error ?? null)) {
          return
        }
        store.updateFolderWorkspace!(scope.folderWorkspaceId, {
          firstAgentMessageRenameError: error
        })
        runtime.notifyFolderWorkspaceChanged()
        return
      }
      const current = store.getWorktreeMeta(worktreeId)?.firstAgentMessageRenameError
      if ((current ?? null) === (error ?? null)) {
        return
      }
      const target = resolveWorktreeMetaOwner(store, worktreeId)
      if (!target) {
        return
      }
      store.setWorktreeMeta(target, { firstAgentMessageRenameError: error })
      runtime.notifyBranchRenamed(getRepoIdFromWorktreeId(worktreeId))
    },
    resolveWorktreeIdForTab: (tabId) => store.getWorktreeIdForTab!(tabId),
    onRenamed: (repoIdOrWorktreeId) => {
      if (parseWorkspaceKey(repoIdOrWorktreeId)?.type === 'folder') {
        runtime.notifyFolderWorkspaceChanged()
        return
      }
      runtime.notifyBranchRenamed(repoIdOrWorktreeId)
    }
  }
}
