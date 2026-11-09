import { getRepoExecutionHostId } from '../../../shared/execution-host'
import {
  assertImportedFolderRemoteMatchesProject,
  resolveImportedFolderProjectLink
} from '../../../shared/imported-folder-project-identity'
import {
  getProjectIdentityKey,
  getProjectIdForProviderIdentity,
  hasProjectRemoteIdentity
} from '../../../shared/project-host-setup-projection'
import type { ProjectHostSetupExistingFolderArgs } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { assertWslMoveHostSetupWritable } from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { readCurrentGitRemoteIdentity } from './repo-git-remote-identity'

export type RepositoryMetadataOwner = {
  enqueueRepositoryMetadata: (repos: readonly Repo[]) => void
  resolveRepositoryMetadata: (repo: Repo) => Promise<boolean>
}

export async function linkImportedFolderToProject(
  getStore: () => RuntimeStore | null,
  initialRepo: Repo,
  folderRemote: Pick<Repo, 'gitRemoteIdentity'>,
  args: ProjectHostSetupExistingFolderArgs,
  metadata: RepositoryMetadataOwner
): Promise<Repo> {
  const store = getStore()
  if (!store) {
    throw new Error('runtime_unavailable')
  }
  const currentRow = (): Repo => {
    const repo = store
      .getRepos()
      .find(
        (entry) =>
          entry.id === initialRepo.id &&
          getRepoExecutionHostId(entry) === getRepoExecutionHostId(initialRepo)
      )
    if (
      getStore() !== store ||
      !repo ||
      repo.path !== initialRepo.path ||
      repo.kind !== initialRepo.kind
    ) {
      throw new Error(`Project setup repo disappeared before it could be linked: ${initialRepo.id}`)
    }
    assertWslMoveHostSetupWritable(store, {
      projectId: args.projectId,
      hostId: getRepoExecutionHostId(repo),
      repoId: repo.id
    })
    return repo
  }
  const project = store.getProjects?.().find((entry) => entry.id === args.projectId)
  const provider = project?.providerIdentity ?? args.projectProviderIdentity
  const selectedProvider =
    provider && getProjectIdForProviderIdentity(provider) === args.projectId ? provider : undefined
  let repo = currentRow()
  // Legacy icon-only matches keep their existing acceptance without a new probe or stamp.
  const legacyMatch =
    getProjectIdentityKey(repo) === args.projectId &&
    repo.repoIcon?.type === 'image' &&
    repo.repoIcon.source === 'github' &&
    !hasProjectRemoteIdentity({ gitRemoteIdentity: folderRemote.gitRemoteIdentity })
  const needsEvidence = !!selectedProvider && repo.upstream === undefined && !legacyMatch
  let metadataFinished = false
  if (needsEvidence) {
    metadataFinished = await metadata.resolveRepositoryMetadata(repo)
    repo = currentRow()
    folderRemote = await readCurrentGitRemoteIdentity({ ...repo, ...folderRemote })
    repo = currentRow()
  }
  const updates: Partial<Repo> = {
    projectHostSetupMethod: args.setupMethod ?? 'imported-existing-folder'
  }
  const keepsCurrentIdentity =
    repo.upstream !== undefined && getProjectIdentityKey(repo) === args.projectId
  if (needsEvidence && !keepsCurrentIdentity) {
    updates.gitRemoteIdentity = folderRemote.gitRemoteIdentity
  }
  const candidate = { ...repo, ...updates }
  const projectedId = getProjectIdentityKey(candidate)
  if (
    projectedId === args.projectId &&
    needsEvidence &&
    repo.upstream === undefined &&
    selectedProvider
  ) {
    assertImportedFolderRemoteMatchesProject(folderRemote, selectedProvider)
  }
  if (projectedId !== args.projectId) {
    Object.assign(
      updates,
      resolveImportedFolderProjectLink(
        { ...candidate, ...folderRemote },
        args.projectId,
        selectedProvider
      )
    )
  } else if (needsEvidence && repo.upstream === undefined) {
    // This successful explicit origin choice is terminal; ordinary failed probes stay unknown.
    updates.upstream = null
  }
  if (getProjectIdentityKey({ ...repo, ...updates }) !== args.projectId) {
    throw new Error('Imported folder does not match the selected project identity.')
  }
  const updated = store.updateRepo(repo, updates)
  if (!updated) {
    throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
  }
  if (getProjectIdentityKey(updated) !== args.projectId) {
    throw new Error('Imported folder does not match the selected project identity.')
  }
  if (!needsEvidence || !metadataFinished) {
    metadata.enqueueRepositoryMetadata([updated])
  }
  return updated
}
