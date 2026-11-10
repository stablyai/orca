import type { Store } from '../persistence/loading-store/store'
import type { Repo } from '../../shared/repo-types'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { getProjectIdentityKey } from '../../shared/project-host-setup-projection'
import type { RecipeWorkspaceCreatePhase } from '../../shared/recipe-workspace-create-progress'
import { sanitizeWorktreeName } from '../ipc/worktree-logic'
import { resolveCreateBranchName } from '../runtime/workspaces/creation/runtime-worktree-create-git'
import { resolveLocalGitUsername } from '../git/git-username'
import { getLocalProjectGitExecOptions } from '../workspaces/execution-host/project-runtime-git-options'
import { resolveWorkspaceProviderRecipe } from './workspace-providers'
import { formatWorkspaceProviderTarget } from '../../shared/workspace-provider-target'
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

/** `worktree.create` with a provider target: the host that owns the provider provisions and adopts. */
export async function createCliRecipeWorkspace(args: {
  store: Store
  userDataPath: string
  repo: Repo
  params: RecipeWorkspaceCreateParams
  pluginService: PluginService | null
  signal?: AbortSignal
  onPhase?: (phase: RecipeWorkspaceCreatePhase, detail?: { runtimeId: string }) => void
}): Promise<RecipeWorkspaceCreation> {
  const { store, userDataPath, repo, params } = args
  if (!params.target) {
    throw new Error('A provider create needs a target.')
  }
  const target = formatWorkspaceProviderTarget(params.target)
  const recipe = await resolveWorkspaceProviderRecipe(repo, params.target, args.pluginService)
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
      target,
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
          [],
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
