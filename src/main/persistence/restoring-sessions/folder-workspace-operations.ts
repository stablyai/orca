import { randomUUID } from 'node:crypto'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import { normalizeFolderWorkspaceName } from '../../../shared/folder-workspaces'
import { getNextProjectGroupOrder } from '../../../shared/project-groups'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { removeWorkspaceSessionOwner } from './session-owner-removal'

export type FolderWorkspaceMutationOperations = {
  state: PersistedState
  scheduleSave: () => void
  removeWorkspaceLineageForFolderParent: (folderWorkspaceId: string) => void
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

  private removeWorkspaceLineageForFolderParent(folderWorkspaceId: string): void {
    this.operations.removeWorkspaceLineageForFolderParent(folderWorkspaceId)
  }

  private pruneMobileClientTabSelections(matchesWorktreeId: (worktreeId: string) => boolean): void {
    this.operations.pruneMobileClientTabSelections(matchesWorktreeId)
  }

  private hydrateRepo(repo: Repo): Repo {
    return this.operations.hydrateRepo(repo)
  }

  getFolderWorkspaces(): FolderWorkspace[] {
    return [...(this.state.folderWorkspaces ?? [])].sort(
      (left, right) => right.sortOrder - left.sortOrder || left.name.localeCompare(right.name)
    )
  }

  getFolderWorkspace(id: string): FolderWorkspace | undefined {
    return (this.state.folderWorkspaces ?? []).find((workspace) => workspace.id === id)
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
    const group = (this.state.projectGroups ?? []).find(
      (entry) => entry.id === input.projectGroupId
    )
    // Why trim: the guard below accepts a padded path, so persist the same value it validated.
    const folderPath =
      typeof input.folderPath === 'string' && input.folderPath.trim().length > 0
        ? input.folderPath
        : group?.parentPath?.trim()
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
    >
  ): FolderWorkspace | null {
    const workspace = this.getFolderWorkspace(id)
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

  removeFolderWorkspace(id: string): boolean {
    const before = this.state.folderWorkspaces?.length ?? 0
    this.state.folderWorkspaces = (this.state.folderWorkspaces ?? []).filter(
      (workspace) => workspace.id !== id
    )
    if ((this.state.folderWorkspaces?.length ?? 0) === before) {
      return false
    }
    this.state.workspaceSession = removeWorkspaceSessionOwner(
      this.state.workspaceSession,
      folderWorkspaceKey(id)
    )!
    this.removeWorkspaceLineageForFolderParent(id)
    this.pruneMobileClientTabSelections((worktreeId) => worktreeId === folderWorkspaceKey(id))
    this.scheduleSave()
    return true
  }

  moveProjectToGroup(repoId: string, groupId: string | null, order?: number): Repo | null {
    const repo = this.state.repos.find((entry) => entry.id === repoId)
    if (!repo) {
      return null
    }
    const normalizedGroupId =
      groupId && (this.state.projectGroups ?? []).some((group) => group.id === groupId)
        ? groupId
        : null
    const siblingRepos = this.state.repos.filter((entry) => entry.id !== repoId)
    repo.projectGroupId = normalizedGroupId
    repo.projectGroupOrder =
      typeof order === 'number' && Number.isFinite(order)
        ? order
        : getNextProjectGroupOrder(siblingRepos, normalizedGroupId)
    this.scheduleSave()
    return this.hydrateRepo(repo)
  }
}
