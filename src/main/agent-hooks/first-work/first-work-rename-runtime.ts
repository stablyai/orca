import { access } from 'node:fs/promises'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import type { FirstWorkRetryDeps } from './first-work-rename-retry'
import type { FirstWorkDismissDeps } from './first-work-rename-dismiss'
import { rememberBranchRenameFailureOutput } from './branch-rename-failure-output'
import { renameWorktreeFolderOnFirstWork } from './first-work-folder-rename'
import { moveWorktree } from '../../git/worktrees/movement/worktree-move'
import { isWslMoveFolderWorkspaceBlocked } from '../../persistence/moving-wsl-projects/orchestration/wsl-move-background-backoff'
import type { Store } from '../../persistence/loading-store/store'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { resolveWorktreeMetaOwner } from '../../persistence/host-qualified-worktree-meta'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

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
    Partial<
      Pick<Store, 'migrateWorktreeIdentity' | 'getWorktreeIdForTab' | 'getWorktreeMetaForHost'>
    >,
  runtime: Pick<
    OrcaRuntimeService,
    | 'getCommitMessageAgentEnvironmentResolvers'
    | 'notifyFolderWorkspaceChanged'
    | 'notifyBranchRenamed'
    | 'notifyWorktreeFolderRenamed'
  >
): FirstWorkBranchRenameDeps {
  // Renames run on this host only, so read this host's row, not a same-id twin's.
  const localMeta = (worktreeId: string) =>
    store.getWorktreeMetaForHost?.(worktreeId, LOCAL_EXECUTION_HOST_ID) ??
    store.getWorktreeMeta(worktreeId)
  const isAutoNameDismissed = (worktreeId: string): boolean => {
    const scope = parseWorkspaceKey(worktreeId)
    return scope?.type === 'folder'
      ? store.getFolderWorkspace!(scope.folderWorkspaceId)?.pendingFirstAgentMessageRename === false
      : localMeta(worktreeId)?.branchNameIsUserChosen === true
  }
  return {
    readIncarnation: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        const folder = store.getFolderWorkspace!(scope.folderWorkspaceId)
        return folder ? `${worktreeId}\u0000${folder.createdAt}` : null
      }
      const meta = localMeta(worktreeId)
      return meta
        ? [
            worktreeId,
            meta.createdAt ?? '',
            meta.orcaCreatedAt ?? '',
            meta.orcaCreationSource ?? ''
          ].join('\u0000')
        : null
    },
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
      const meta = localMeta(worktreeId)
      // A creature-like name alone cannot prove Orca owns the branch.
      return (
        !!meta?.orcaCreationSource &&
        meta.preserveBranchOnDelete !== true &&
        meta.branchNameIsUserChosen !== true
      )
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
            pathExists: (candidate) =>
              access(candidate).then(
                () => true,
                () => false
              ),
            moveWorktree
          })
      : undefined,
    setRenameError: (worktreeId, error, failureOutput) => {
      // A dismissed workspace keeps its name; a late attempt must not bring the error back.
      if (error !== null && isAutoNameDismissed(worktreeId)) {
        return
      }
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

export function firstWorkDismissDeps(
  store: Parameters<typeof firstWorkRenameDeps>[0],
  runtime: Parameters<typeof firstWorkRenameDeps>[1]
): FirstWorkDismissDeps {
  // Only this host's row counts: a same-id row from another host must not stand in for it.
  const localMeta = (worktreeId: string) =>
    store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(worktreeId, LOCAL_EXECUTION_HOST_ID)
      : store.getWorktreeMeta(worktreeId)
  return {
    readIncarnation: firstWorkRenameDeps(store, runtime).readIncarnation,
    keepCurrentName: (worktreeId) => {
      rememberBranchRenameFailureOutput(worktreeId, null)
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        if (!store.getFolderWorkspace!(scope.folderWorkspaceId)) {
          return false
        }
        store.updateFolderWorkspace!(scope.folderWorkspaceId, {
          pendingFirstAgentMessageRename: false,
          firstAgentMessageRenameError: null
        })
        runtime.notifyFolderWorkspaceChanged()
        return true
      }
      if (!localMeta(worktreeId)) {
        return false
      }
      // This host's own row, as auto-naming reads it; a same-id repo on another host must not hide it.
      // The same mark an in-app branch switch leaves: first-work naming must not rename this branch.
      store.setWorktreeMeta(
        hostWorktreeTarget({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID }),
        {
          branchNameIsUserChosen: true,
          pendingFirstAgentMessageRename: false,
          firstAgentMessageRenameError: null
        }
      )
      runtime.notifyBranchRenamed(getRepoIdFromWorktreeId(worktreeId))
      return true
    }
  }
}

export function firstWorkRetryDeps(
  store: Parameters<typeof firstWorkRenameDeps>[0],
  runtime: Parameters<typeof firstWorkRenameDeps>[1] &
    Pick<OrcaRuntimeService, 'listWorkspaceStructuredSessions' | 'openAgentSessionRecordStore'>
): FirstWorkRetryDeps {
  const localMeta = (worktreeId: string) =>
    store.getWorktreeMetaForHost?.(worktreeId, LOCAL_EXECUTION_HOST_ID) ??
    store.getWorktreeMeta(worktreeId)
  return {
    ...firstWorkRenameDeps(store, runtime),
    getWorkspaceCreatedAt: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        return store.getFolderWorkspace!(scope.folderWorkspaceId)?.createdAt
      }
      const meta = localMeta(worktreeId)
      return meta?.createdAt ?? meta?.orcaCreatedAt
    },
    getBaseRef: (worktreeId) => localMeta(worktreeId)?.baseRef,
    nativeReads: (worktreeId) => ({
      listSessions: () => runtime.listWorkspaceStructuredSessions(worktreeId),
      readFirst: async (sessionId, sinceMs) =>
        (await runtime.openAgentSessionRecordStore()).firstSubmittedUserPrompt(sessionId, sinceMs)
    })
  }
}
