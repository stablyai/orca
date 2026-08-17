import { randomUUID } from 'node:crypto'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import {
  normalizeFolderWorkspaceName,
  resolveFolderWorkspaceCatalogOwnerHostId
} from '../../../shared/folder-workspaces'
import {
  buildProjectGroupOwnerIndex,
  resolveProjectGroupOwner
} from '../../../shared/project-groups'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'
import {
  findFolderWorkspaceForOwner,
  sortFolderWorkspaces
} from './folder-workspace-owner-resolution'
import { moveProjectToGroupForOwner } from './project-group-repo-move'

export type FolderWorkspaceMutationOperations = {
  state: StoreOwnedPersistedState
  scheduleSave: () => void
  removeWorkspaceLineageForFolderParent: (
    folderWorkspaceId: string,
    ownerHostId?: ExecutionHostId | null,
    removeBareKey?: boolean
  ) => void
  removeWorkspaceSessionStateForWorktree: (
    worktreeId: string,
    ownerHostId?: ExecutionHostId | null
  ) => void
  pruneMobileClientTabSelections: (matchesWorktreeId: (worktreeId: string) => boolean) => void
  hydrateRepo: (repo: Repo) => Repo
}

export class FolderWorkspacePersistenceOperations {
  constructor(private readonly operations: FolderWorkspaceMutationOperations) {}

  private get state(): PersistedState {
    return this.operations.state
  }

  private scheduleSave(): void {
    this.operations.scheduleSave()
  }

  private removeWorkspaceLineageForFolderParent(
    folderWorkspaceId: string,
    ownerHostId?: ExecutionHostId | null,
    removeBareKey?: boolean
  ): void {
    this.operations.removeWorkspaceLineageForFolderParent(
      folderWorkspaceId,
      ownerHostId,
      removeBareKey
    )
  }

  private pruneMobileClientTabSelections(matchesWorktreeId: (worktreeId: string) => boolean): void {
    this.operations.pruneMobileClientTabSelections(matchesWorktreeId)
  }

  private hydrateRepo(repo: Repo): Repo {
    return this.operations.hydrateRepo(repo)
  }

  getFolderWorkspaces(): FolderWorkspace[] {
    return sortFolderWorkspaces(this.state.folderWorkspaces ?? [])
  }

  getFolderWorkspace(id: string, ownerHostId?: ExecutionHostId): FolderWorkspace | undefined {
    return findFolderWorkspaceForOwner(
      this.state.folderWorkspaces ?? [],
      this.state.projectGroups ?? [],
      id,
      ownerHostId
    )
  }

  createFolderWorkspace(input: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    linkedTask?: FolderWorkspace['linkedTask']
    linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
    connectionId?: string | null
    creatorProvenance?: FolderWorkspace['creatorProvenance']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
  }): FolderWorkspace {
    const projectGroupIndex = buildProjectGroupOwnerIndex(this.state.projectGroups ?? [])
    const group = resolveProjectGroupOwner(
      projectGroupIndex,
      input.projectGroupId,
      input.connectionId !== undefined
        ? input.connectionId
          ? toSshExecutionHostId(input.connectionId)
          : LOCAL_EXECUTION_HOST_ID
        : undefined
    )
    const folderPath =
      typeof input.folderPath === 'string' && input.folderPath.trim().length > 0
        ? input.folderPath
        : group?.parentPath
    if (!group || !folderPath) {
      throw new Error('Folder-backed project group not found.')
    }
    const now = Date.now()
    const linkedTask = normalizeWorkspaceLinkedItem(input.linkedTask)
    const sourceContext = normalizeStoredTaskSourceContext(input.linkedTaskSourceContext)
    const workspace: FolderWorkspace = {
      id: randomUUID(),
      projectGroupId: group.id,
      name: normalizeFolderWorkspaceName(input.name, `${group.name} workspace`),
      folderPath,
      connectionId: input.connectionId ?? group.connectionId ?? null,
      ...(input.creatorProvenance ? { creatorProvenance: input.creatorProvenance } : {}),
      linkedTask,
      linkedTaskSourceContext: isWorkspaceLinkedItemSourceContextMatch(linkedTask, sourceContext)
        ? sourceContext
        : null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: now,
      ...(input.createdWithAgent ? { createdWithAgent: input.createdWithAgent } : {}),
      ...(input.pendingFirstAgentMessageRename === true && input.createdWithAgent
        ? { pendingFirstAgentMessageRename: true }
        : {}),
      lastActivityAt: 0,
      createdAt: now,
      updatedAt: now
    }
    this.state.folderWorkspaces = [workspace, ...(this.state.folderWorkspaces ?? [])]
    this.scheduleSave()
    return workspace
  }

  updateFolderWorkspace(
    id: string,
    updates: Partial<
      Pick<
        FolderWorkspace,
        | 'name'
        | 'folderPath'
        | 'linkedTask'
        | 'linkedTaskSourceContext'
        | 'comment'
        | 'isArchived'
        | 'isUnread'
        | 'isPinned'
        | 'sortOrder'
        | 'manualOrder'
        | 'workspaceStatus'
        | 'createdWithAgent'
        | 'pendingFirstAgentMessageRename'
        | 'firstAgentMessageRenameError'
        | 'lastActivityAt'
        | 'diffComments'
      >
    >,
    ownerHostId?: ExecutionHostId
  ): FolderWorkspace | null {
    const workspace = this.getFolderWorkspace(id, ownerHostId)
    if (!workspace) {
      return null
    }
    if (updates.name !== undefined) {
      workspace.name = normalizeFolderWorkspaceName(updates.name, workspace.name)
    }
    if (typeof updates.folderPath === 'string' && updates.folderPath.trim().length > 0) {
      workspace.folderPath = updates.folderPath
    }
    if (updates.linkedTask !== undefined) {
      workspace.linkedTask = normalizeWorkspaceLinkedItem(updates.linkedTask)
      if (
        workspace.linkedTaskSourceContext &&
        !isWorkspaceLinkedItemSourceContextMatch(
          workspace.linkedTask,
          workspace.linkedTaskSourceContext
        )
      ) {
        workspace.linkedTaskSourceContext = null
      }
    }
    if (updates.linkedTaskSourceContext !== undefined) {
      const linkedTaskSourceContext = normalizeStoredTaskSourceContext(
        updates.linkedTaskSourceContext
      )
      workspace.linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
        workspace.linkedTask,
        linkedTaskSourceContext
      )
        ? linkedTaskSourceContext
        : null
    }
    if (updates.comment !== undefined) {
      workspace.comment = updates.comment
    }
    if (updates.isArchived !== undefined) {
      workspace.isArchived = updates.isArchived
    }
    if (updates.isUnread !== undefined) {
      workspace.isUnread = updates.isUnread
    }
    if (updates.isPinned !== undefined) {
      workspace.isPinned = updates.isPinned
    }
    if (updates.sortOrder !== undefined && Number.isFinite(updates.sortOrder)) {
      workspace.sortOrder = updates.sortOrder
    }
    if (updates.manualOrder !== undefined) {
      if (Number.isFinite(updates.manualOrder)) {
        workspace.manualOrder = updates.manualOrder
      } else {
        delete workspace.manualOrder
      }
    }
    if (updates.workspaceStatus !== undefined) {
      workspace.workspaceStatus = updates.workspaceStatus
    }
    if (updates.createdWithAgent !== undefined) {
      workspace.createdWithAgent = updates.createdWithAgent
    }
    if (updates.pendingFirstAgentMessageRename !== undefined) {
      workspace.pendingFirstAgentMessageRename = updates.pendingFirstAgentMessageRename
    }
    if (updates.firstAgentMessageRenameError !== undefined) {
      workspace.firstAgentMessageRenameError = updates.firstAgentMessageRenameError
    }
    if (updates.lastActivityAt !== undefined && Number.isFinite(updates.lastActivityAt)) {
      workspace.lastActivityAt = updates.lastActivityAt
    }
    if (updates.diffComments !== undefined) {
      workspace.diffComments = updates.diffComments
    }
    workspace.updatedAt = Date.now()
    this.scheduleSave()
    return workspace
  }

  removeFolderWorkspace(id: string, ownerHostId?: ExecutionHostId): boolean {
    const workspace = this.getFolderWorkspace(id, ownerHostId)
    if (!workspace) {
      return false
    }
    this.state.folderWorkspaces = (this.state.folderWorkspaces ?? []).filter(
      (candidate) => candidate !== workspace
    )
    const resolvedOwnerHostId =
      ownerHostId ??
      resolveFolderWorkspaceCatalogOwnerHostId(workspace, this.state.projectGroups ?? []) ??
      undefined
    const removeBareKey = !this.state.folderWorkspaces.some((candidate) => candidate.id === id)
    const keys = new Set<string>()
    if (resolvedOwnerHostId) {
      keys.add(folderWorkspaceKey(id, resolvedOwnerHostId))
    }
    if (removeBareKey) {
      keys.add(folderWorkspaceKey(id))
    }
    for (const key of keys) {
      this.operations.removeWorkspaceSessionStateForWorktree(key, resolvedOwnerHostId)
    }
    this.removeWorkspaceLineageForFolderParent(id, resolvedOwnerHostId, removeBareKey)
    this.pruneMobileClientTabSelections((worktreeId) => keys.has(worktreeId))
    this.scheduleSave()
    return true
  }

  moveProjectToGroup(
    repoId: string,
    groupId: string | null,
    order?: number,
    ownerHostId?: ExecutionHostId
  ): Repo | null {
    return moveProjectToGroupForOwner({
      state: this.state,
      repoId,
      groupId,
      order,
      ownerHostId,
      hydrateRepo: (repo) => this.hydrateRepo(repo),
      scheduleSave: () => this.scheduleSave()
    })
  }
}
