import type { Store } from '../persistence/loading-store/store'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { sanitizeWorktreeName } from '../ipc/worktree-logic'
import { resolveCreateBranchName } from '../runtime/workspaces/creation/runtime-worktree-create-git'
import { resolveLocalGitUsername } from '../git/git-username'
import { getLocalProjectGitExecOptions } from '../workspaces/execution-host/project-runtime-git-options'
import { resolveRecipeForRepo } from '../ipc/ephemeral-vm-recipe-context'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import type { PluginService } from '../plugins/plugin-service'
import { provisionRecipeEnvironment } from './environment-provision'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { retireRemovedRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-removal-cleanup'
import { attachEphemeralVmRuntimeToWorkspace } from './runtime-attachment'
import { cleanupEphemeralVmRuntime } from './runtime-service'
import { releaseEphemeralVmRuntimeEnvironments } from './runtime-environment-release'
import { removeEphemeralVmRuntimeSshTarget } from './runtime-ssh-cleanup'
import { removeRuntimeOwnedSshTarget } from './runtime-ssh'
import {
  createProvisionedRecipeWorkspace,
  type RecipeWorkspaceCreateParams,
  type RecipeWorkspaceCreation
} from './recipe-workspace-create'

export async function createCliRecipeWorkspace(args: {
  store: Store
  userDataPath: string
  repo: Repo
  params: RecipeWorkspaceCreateParams
  pluginService: PluginService | null
}): Promise<RecipeWorkspaceCreation> {
  const { store, userDataPath, repo, params } = args
  if (isFolderRepo(repo) || getRepoExecutionHostId(repo) !== 'local') {
    throw new Error('Environment recipes require a Git checkout on the provisioning host.')
  }
  const pluginRecipes = await getApprovedPluginVmRecipes(args.pluginService ?? undefined)
  const recipe = params.recipeId && resolveRecipeForRepo(repo.path, params.recipeId, pluginRecipes)
  if (!recipe || recipe.checkoutMode !== 'provisioned-root') {
    throw new Error('Select a provisioned-root environment recipe from this repository.')
  }
  const settings = store.getSettings()
  const username =
    settings.branchPrefix === 'git-username' ? await resolveLocalGitUsername(repo.path) : ''
  const branchName = await resolveCreateBranchName(
    repo.path,
    params.branchNameOverride,
    sanitizeWorktreeName(params.name ?? ''),
    settings,
    username,
    getLocalProjectGitExecOptions(store, repo)
  )
  const projectId = getProjectHostSetupForRepo(store.getProjectHostSetups(), repo).projectId
  return createProvisionedRecipeWorkspace(
    { params, branchName, projectId },
    {
      provision: () =>
        provisionRecipeEnvironment(
          store,
          userDataPath,
          {
            repoId: repo.id,
            recipeId: recipe.id,
            workspaceName: params.name,
            projectId,
            branch: branchName,
            ref: params.baseBranch
          },
          pluginRecipes,
          { repo }
        ),
      call: (environmentId, method, payload) =>
        callRuntimeEnvironment(userDataPath, `id:${environmentId}`, method, payload, 600_000),
      attach: (runtimeId, workspaceId) => {
        attachEphemeralVmRuntimeToWorkspace({ userDataPath, runtimeId, workspaceId })
      },
      cleanup: async (runtimeId) => {
        const cleaned = await cleanupEphemeralVmRuntime({
          userDataPath,
          repoPath: repo.path,
          recipe,
          runtimeId
        })
        if (!cleaned.ok) {
          throw new Error(cleaned.error)
        }
        try {
          await releaseEphemeralVmRuntimeEnvironments(
            userDataPath,
            cleaned.runtime,
            (environmentId) => {
              void retireRemovedRuntimeEnvironment(
                environmentId,
                invalidateRuntimeEnvironmentTransport,
                store,
                userDataPath
              )
            }
          )
        } catch {
          // The provider resources are gone; a stale local environment row must not block removing the SSH target.
        }
        await removeEphemeralVmRuntimeSshTarget({
          userDataPath,
          runtime: cleaned.runtime,
          removeTarget: removeRuntimeOwnedSshTarget
        })
      }
    }
  )
}
