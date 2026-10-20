import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult
} from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { resolveImportedFolderProjectLink } from '../../shared/imported-folder-project-identity'
import { assertWslMoveHostSetupWritable } from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import type { RuntimeStore } from './runtime-store-contract'

/** Points a just-registered repo at the project the caller asked for and returns its setup row. */
export function linkRepoToRequestedProject(
  store: RuntimeStore | null,
  args: ProjectHostSetupExistingFolderArgs,
  initialRepo: Repo,
  folderRemote: Pick<Repo, 'gitRemoteIdentity'>
): ProjectHostSetupResult {
  if (!store) {
    throw new Error('runtime_unavailable')
  }
  const listSetups = () => store.getProjectHostSetups?.() ?? []
  const listProjects = () => store.getProjects?.() ?? []
  assertWslMoveHostSetupWritable(store, {
    projectId: args.projectId,
    hostId: getRepoExecutionHostId(initialRepo),
    repoId: initialRepo.id
  })
  let repo = initialRepo
  let setup = getProjectHostSetupForRepo(listSetups(), repo)
  if (setup.projectId !== args.projectId) {
    const existingProject = listProjects().find((project) => project.id === args.projectId)
    const updated = store.updateRepo(
      repo,
      resolveImportedFolderProjectLink(
        folderRemote,
        args.projectId,
        existingProject?.providerIdentity ?? args.projectProviderIdentity
      )
    )
    if (!updated) {
      throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
    }
    repo = updated
    setup = getProjectHostSetupForRepo(listSetups(), repo)
  }
  const setupMethod = args.setupMethod ?? 'imported-existing-folder'
  const updated = store.updateRepo(repo, { projectHostSetupMethod: setupMethod })
  if (!updated) {
    throw new Error(
      `Project setup repo disappeared before setup metadata could be linked: ${repo.id}`
    )
  }
  repo = updated
  setup = getProjectHostSetupForRepo(listSetups(), repo)
  const project = listProjects().find((entry) => entry.id === setup.projectId)
  if (!project) {
    throw new Error(`Project setup was created without a project record: ${setup.projectId}`)
  }
  return { project, setup, repo }
}
