import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs
} from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { ProjectGroupPersistenceOperations } from '../tracking-repos/project-group-operations'
import { FolderWorkspacePersistenceOperations } from '../restoring-sessions/folder-workspace-operations'
import { ProjectHostPersistenceOperations } from '../tracking-repos/project-host-operations'

import type { StoreRuntimeState } from './store-runtime-state'
import type { RepoLifecycleOperations } from './repo-lifecycle-operations'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { MetadataLineageOperations } from './metadata-lineage-operations'
import {
  hydrateRepo,
  updateRepoBackedProjectHostSetup,
  updateIndependentProjectHostSetup,
  pruneMobileClientTabSelections
} from './repo-lifecycle-operations'
import { scheduleSave } from './write-scheduling'
import { removeWorkspaceLineageForFolderParent } from './metadata-lineage-operations'

type ProjectCollectionOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'folderWorkspaceOperations'
  | 'gitUsernameCache'
  | 'projectGroupOperations'
  | 'projectHostOperations'
  | 'state'
>

const projectCollectionOperationsContext = Symbol('ProjectCollectionOperations')
type ProjectCollectionOperationsContext = {
  runtime: ProjectCollectionOperationsRuntime
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
  metadata: MetadataLineageOperations
}

export class ProjectCollectionOperations {
  readonly [projectCollectionOperationsContext]: ProjectCollectionOperationsContext

  constructor(
    runtime: ProjectCollectionOperationsRuntime,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations,
    metadata: MetadataLineageOperations
  ) {
    this[projectCollectionOperationsContext] = { runtime, repos, scheduling, metadata }
  }

  getRepos(): Repo[] {
    return getProjectHostOperations(this).getRepos()
  }

  getProjects(): Project[] {
    return getProjectHostOperations(this).getProjects()
  }

  updateProject(id: string, updates: ProjectUpdateArgs['updates']): Project | null {
    return getProjectHostOperations(this).updateProject(id, updates)
  }

  getProjectHostSetups(): ProjectHostSetup[] {
    return getProjectHostOperations(this).getProjectHostSetups()
  }

  createProjectHostSetup(args: ProjectHostSetupCreateArgs): ProjectHostSetupCreateResult | null {
    return getProjectHostOperations(this).createProjectHostSetup(args)
  }

  updateProjectHostSetup(args: ProjectHostSetupUpdateArgs): ProjectHostSetupUpdateResult | null {
    return getProjectHostOperations(this).updateProjectHostSetup(args)
  }

  deleteProjectHostSetup(args: ProjectHostSetupDeleteArgs): ProjectHostSetupDeleteResult | null {
    return getProjectHostOperations(this).deleteProjectHostSetup(args)
  }

  getRepoCount(): number {
    return getProjectHostOperations(this).getRepoCount()
  }

  getRepo(id: string): Repo | undefined {
    return getProjectHostOperations(this).getRepo(id)
  }

  setResolvedRepoGitUsername(
    target: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    username: string
  ): boolean {
    return getProjectHostOperations(this).setResolvedRepoGitUsername(target, username)
  }

  getProjectGroups(): ProjectGroup[] {
    return getProjectGroupOperations(this).getProjectGroups()
  }

  createProjectGroup(
    input: Parameters<ProjectGroupPersistenceOperations['createProjectGroup']>[0]
  ): ProjectGroup {
    return getProjectGroupOperations(this).createProjectGroup(input)
  }

  updateProjectGroup(
    groupId: string,
    updates: Parameters<ProjectGroupPersistenceOperations['updateProjectGroup']>[1]
  ): ProjectGroup | null {
    return getProjectGroupOperations(this).updateProjectGroup(groupId, updates)
  }

  deleteProjectGroup(groupId: string): boolean {
    return getProjectGroupOperations(this).deleteProjectGroup(groupId)
  }

  getFolderWorkspaces(): FolderWorkspace[] {
    return getFolderWorkspaceOperations(this).getFolderWorkspaces()
  }

  getFolderWorkspace(id: string): FolderWorkspace | undefined {
    return getFolderWorkspaceOperations(this).getFolderWorkspace(id)
  }

  createFolderWorkspace(
    input: Parameters<FolderWorkspacePersistenceOperations['createFolderWorkspace']>[0]
  ): FolderWorkspace {
    return getFolderWorkspaceOperations(this).createFolderWorkspace(input)
  }

  updateFolderWorkspace(
    id: string,
    updates: Parameters<FolderWorkspacePersistenceOperations['updateFolderWorkspace']>[1]
  ): FolderWorkspace | null {
    return getFolderWorkspaceOperations(this).updateFolderWorkspace(id, updates)
  }

  removeFolderWorkspace(id: string): boolean {
    return getFolderWorkspaceOperations(this).removeFolderWorkspace(id)
  }

  moveProjectToGroup(repoId: string, groupId: string | null, order?: number): Repo | null {
    return getFolderWorkspaceOperations(this).moveProjectToGroup(repoId, groupId, order)
  }
}

export function getProjectHostOperations(
  owner: ProjectCollectionOperations
): ProjectHostPersistenceOperations {
  owner[projectCollectionOperationsContext].runtime.projectHostOperations ??=
    new ProjectHostPersistenceOperations({
      state: owner[projectCollectionOperationsContext].runtime.state,
      gitUsernameCache: owner[projectCollectionOperationsContext].runtime.gitUsernameCache,
      hydrateRepo: (repo) => hydrateRepo(owner[projectCollectionOperationsContext].repos, repo),
      updateRepoBackedProjectHostSetup: (setup, repo, updates) =>
        updateRepoBackedProjectHostSetup(
          owner[projectCollectionOperationsContext].repos,
          setup,
          repo,
          updates
        ),
      updateIndependentProjectHostSetup: (setup, updates) =>
        updateIndependentProjectHostSetup(
          owner[projectCollectionOperationsContext].repos,
          setup,
          updates
        ),
      removeProjectForHost: (id, hostId) =>
        owner[projectCollectionOperationsContext].repos.removeProjectForHost(id, hostId),
      scheduleSave: () => scheduleSave(owner[projectCollectionOperationsContext].scheduling)
    })
  return owner[projectCollectionOperationsContext].runtime.projectHostOperations
}

export function getProjectGroupOperations(
  owner: ProjectCollectionOperations
): ProjectGroupPersistenceOperations {
  owner[projectCollectionOperationsContext].runtime.projectGroupOperations ??=
    new ProjectGroupPersistenceOperations({
      state: owner[projectCollectionOperationsContext].runtime.state,
      scheduleSave: () => scheduleSave(owner[projectCollectionOperationsContext].scheduling),
      removeWorkspaceLineageForFolderParent: (folderWorkspaceId) =>
        removeWorkspaceLineageForFolderParent(
          owner[projectCollectionOperationsContext].metadata,
          folderWorkspaceId
        ),
      pruneMobileClientTabSelections: (matchesWorktreeId) =>
        pruneMobileClientTabSelections(
          owner[projectCollectionOperationsContext].repos,
          matchesWorktreeId
        )
    })
  return owner[projectCollectionOperationsContext].runtime.projectGroupOperations
}

export function getFolderWorkspaceOperations(
  owner: ProjectCollectionOperations
): FolderWorkspacePersistenceOperations {
  owner[projectCollectionOperationsContext].runtime.folderWorkspaceOperations ??=
    new FolderWorkspacePersistenceOperations({
      state: owner[projectCollectionOperationsContext].runtime.state,
      scheduleSave: () => scheduleSave(owner[projectCollectionOperationsContext].scheduling),
      removeWorkspaceLineageForFolderParent: (folderWorkspaceId) =>
        removeWorkspaceLineageForFolderParent(
          owner[projectCollectionOperationsContext].metadata,
          folderWorkspaceId
        ),
      pruneMobileClientTabSelections: (matchesWorktreeId) =>
        pruneMobileClientTabSelections(
          owner[projectCollectionOperationsContext].repos,
          matchesWorktreeId
        ),
      hydrateRepo: (repo) => hydrateRepo(owner[projectCollectionOperationsContext].repos, repo)
    })
  return owner[projectCollectionOperationsContext].runtime.folderWorkspaceOperations
}

export function installProjectCollectionOperationsContext(
  target: object,
  source: ProjectCollectionOperations
): void {
  Object.defineProperty(target, projectCollectionOperationsContext, {
    value: source[projectCollectionOperationsContext]
  })
}
