import type { Store } from '../persistence/loading-store/store'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { getProjectIdentityKey } from '../../shared/project-host-setup-projection'
import type {
  RecipeCatalogListing,
  RecipeWorkspaceCreatePhase
} from '../../shared/recipe-workspace-create-progress'
import { sanitizeWorktreeName } from '../ipc/worktree-logic'
import { resolveCreateBranchName } from '../runtime/workspaces/creation/runtime-worktree-create-git'
import { resolveLocalGitUsername } from '../git/git-username'
import { getLocalProjectGitExecOptions } from '../workspaces/execution-host/project-runtime-git-options'
import {
  listRecipeCatalog,
  listRecipes,
  resolveRecipeForRepo
} from '../ipc/ephemeral-vm-recipe-context'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { getApprovedPluginVmRecipes } from '../plugins/plugin-approved-vm-recipes'
import type { PluginService } from '../plugins/plugin-service'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'
import { provisionRecipeEnvironment } from './environment-provision'
import { attachEphemeralVmRuntimeToWorkspace } from './runtime-attachment'
import { cleanupOwnedEphemeralVmRuntime } from './owned-runtime-cleanup'
import {
  createProvisionedRecipeWorkspace,
  type RecipeWorkspaceCreateParams,
  type RecipeWorkspaceCreation
} from './recipe-workspace-create'

// Each call to the new environment's Orca is one short step; the recipe's own timeouts bound the create.
const ENVIRONMENT_STEP_TIMEOUT_MS = 600_000

/** `worktree.create` with a recipe id: the host that owns the recipe provisions and adopts. */
export async function createCliRecipeWorkspace(args: {
  store: Store
  userDataPath: string
  repo: Repo
  params: RecipeWorkspaceCreateParams
  pluginService: PluginService | null
  signal?: AbortSignal
  onPhase?: (phase: RecipeWorkspaceCreatePhase) => void
}): Promise<RecipeWorkspaceCreation> {
  const { store, userDataPath, repo, params } = args
  if (isFolderRepo(repo) || getRepoExecutionHostId(repo) !== 'local') {
    throw new Error('Environment recipes need a Git checkout on this computer.')
  }
  const pluginRecipes = await getApprovedPluginVmRecipes(args.pluginService ?? undefined)
  const recipe = params.recipeId
    ? resolveRecipeForRepo(repo.path, params.recipeId, pluginRecipes)
    : null
  if (!recipe) {
    throw new Error(
      `Recipe not found: ${params.recipeId ?? ''}. Run \`orca vm recipe list\` to see this repo's recipes.`
    )
  }
  const checkoutMode = recipe.checkoutMode ?? 'orca-worktree'
  let branchName: string | undefined
  if (checkoutMode === 'provisioned-root') {
    const settings = store.getSettings()
    const username =
      settings.branchPrefix === 'git-username' ? await resolveLocalGitUsername(repo.path) : ''
    branchName = await resolveCreateBranchName(
      repo.path,
      params.branchNameOverride,
      sanitizeWorktreeName(params.name ?? ''),
      settings,
      username,
      getLocalProjectGitExecOptions(store, repo)
    )
  }
  // Same project identity the desktop's recipe flow gives the environment: the portable GitHub key when there is one.
  const portableProjectId = getProjectIdentityKey(repo)
  const projectId = portableProjectId.startsWith('github:')
    ? portableProjectId
    : getProjectHostSetupForRepo(store.getProjectHostSetups(), repo).projectId
  return createProvisionedRecipeWorkspace(
    {
      params,
      recipeId: recipe.id,
      checkoutMode,
      ...(branchName ? { branchName } : {}),
      projectId,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.onPhase ? { onPhase: args.onPhase } : {})
    },
    {
      provision: (onPhase) =>
        provisionRecipeEnvironment(
          store,
          userDataPath,
          {
            repoId: repo.id,
            recipeId: recipe.id,
            workspaceName: params.name,
            projectId,
            ...(branchName ? { branch: branchName } : {}),
            ...(checkoutMode === 'provisioned-root' && params.baseBranch
              ? { ref: params.baseBranch }
              : {})
          },
          pluginRecipes,
          { repo, recipe, signal: args.signal, onPhase }
        ),
      call: (environmentId, method, payload) =>
        callRuntimeEnvironment(
          getRuntimeEnvironmentRegistryRoot(),
          `id:${environmentId}`,
          method,
          payload,
          ENVIRONMENT_STEP_TIMEOUT_MS,
          undefined,
          undefined,
          // Ctrl+C on the CLI stops the step in flight, so the VM is destroyed right away.
          args.signal ? { signal: args.signal } : undefined
        ),
      attach: (runtimeId, workspaceId) => {
        attachEphemeralVmRuntimeToWorkspace({ userDataPath, runtimeId, workspaceId })
      },
      cleanup: async (runtimeId) => {
        const runtime = await cleanupOwnedEphemeralVmRuntime(store, userDataPath, runtimeId)
        if (runtime.status === 'cleaned') {
          // A recipe without a destroy step is marked cleaned without running anything.
          return { outcome: runtime.cleanupStatus === 'disabled' ? 'disabled' : 'destroyed' }
        }
        return {
          outcome: 'failed',
          ...(runtime.cleanupLastError ? { error: runtime.cleanupLastError } : {})
        }
      }
    }
  )
}

function toListedRecipe(recipe: OrcaVmRecipe): RecipeCatalogListing['recipes'][number] {
  return {
    id: recipe.id,
    name: recipe.name,
    ...(recipe.description ? { description: recipe.description } : {}),
    checkoutMode: recipe.checkoutMode ?? 'orca-worktree',
    steps: (['suspend', 'resume', 'destroy'] as const).filter((step) => Boolean(recipe[step])),
    destroyDisabled: recipe.destroyDisabled === true,
    ...(recipe.timeoutSeconds ? { timeoutSeconds: recipe.timeoutSeconds } : {})
  }
}

/** The recipes `worktree create --recipe` accepts: orca.yaml plus approved plugin recipes. */
export async function listCliEnvironmentRecipes(
  store: Store,
  repo: Repo | null,
  pluginService: PluginService | null
): Promise<RecipeCatalogListing[]> {
  const pluginRecipes = await getApprovedPluginVmRecipes(pluginService ?? undefined)
  if (repo) {
    const listed = listRecipes(store, repo.id, pluginRecipes)
    if (listed.status === 'error') {
      throw new Error(listed.message ?? 'Could not read environment recipes for this repo.')
    }
    return [
      {
        repoId: repo.id,
        repoName: repo.displayName,
        repoPath: repo.path,
        recipes: listed.recipes.map(toListedRecipe),
        diagnostics: listed.diagnostics ?? []
      }
    ]
  }
  return listRecipeCatalog(store, pluginRecipes).map((entry) => ({
    repoId: entry.repoId,
    repoName: entry.repoName,
    repoPath: entry.repoPath,
    recipes: entry.recipes.map(toListedRecipe),
    diagnostics: entry.diagnostics ?? []
  }))
}
