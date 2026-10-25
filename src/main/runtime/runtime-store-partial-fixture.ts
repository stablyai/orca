import type { RuntimeStore } from './runtime-store-contract'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Project } from '../../shared/project-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'

type RuntimeSettings = ReturnType<RuntimeStore['getSettings']>

export type PartialRuntimeStore = Partial<Omit<RuntimeStore, 'getSettings'>> & {
  // Any persisted setting may be stubbed: the store returns all of them, not just the runtime's.
  getSettings?: () => Partial<RuntimeSettings> &
    Partial<Omit<GlobalSettings, keyof RuntimeSettings>>
}

function unstubbedWrite(member: string): () => never {
  return () => {
    throw new Error(`runtime store fake does not stub ${member}`)
  }
}

/** A runtime store fake: empty reads and refused writes beyond the members a test supplies. */
export function partialRuntimeStore(overrides: PartialRuntimeStore = {}): RuntimeStore {
  const { getSettings, ...members } = overrides
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    addRepo: unstubbedWrite('addRepo'),
    updateRepo: unstubbedWrite('updateRepo'),
    setWorktreeMeta: unstubbedWrite('setWorktreeMeta'),
    removeWorktreeMeta: unstubbedWrite('removeWorktreeMeta'),
    ...members,
    getSettings: () => ({
      workspaceDir: '',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      ...getSettings?.()
    })
  }
}

/** A persisted repo row as the store returns it. */
export function storeRepo(fields: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return { displayName: fields.id, badgeColor: '#737373', addedAt: 0, ...fields }
}

/** A persisted worktree meta row as the store returns it. */
export function storeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

/** A persisted project row as the store returns it. */
export function storeProject(fields: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    displayName: fields.id,
    badgeColor: '#737373',
    sourceRepoIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...fields
  }
}

/** A persisted project group row as the store returns it. */
export function storeProjectGroup(
  fields: Partial<ProjectGroup> & Pick<ProjectGroup, 'id'>
): ProjectGroup {
  return {
    name: fields.id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...fields
  }
}

/** A persisted folder workspace row as the store returns it. */
export function storeFolderWorkspace(
  fields: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'folderPath'>
): FolderWorkspace {
  return {
    name: fields.id,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...fields
  }
}
