import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getProjectHostSetupForRepo } from '../../shared/project/host-setup/project-host-setup-lookup'
import { resolvePortableRecipeProjectId } from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-target'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import {
  provisionRecipeEnvironment,
  resolveRecipeProvisionTarget
} from './recipe-environment-provision'
import { createRecipeWorkspace } from './recipe-workspace-create'
import { cleanupOwnedEphemeralVmRuntime } from './owned-runtime-cleanup'
import { attachEphemeralVmRuntimeToWorkspace } from './runtime-attachment'
import { hideMainVmCreateCheckout } from './pending-vm-checkouts'
import { CLOUD_VMS_DISABLED_CODE } from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-create-contract'
import { ephemeralVmFailure } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-failure-copy'

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_argument' })
}

/** Desktop-only: `orca worktree create --on recipe:<id>` runs here, where the recipe and its VMs live. */
export function wireRecipeWorkspaceCreation(
  runtime: OrcaRuntimeService,
  store: Store,
  userDataPath: () => string
): void {
  runtime.setRecipeWorkspaceCreation({
    create: async (params, repo, options) => {
      if (store.getSettings().experimentalEphemeralVms !== true) {
        throw Object.assign(
          new Error(
            'Cloud VM recipes are an experimental feature that is turned off. Turn on Settings > Experimental > Cloud VM in Orca, then retry.'
          ),
          { code: CLOUD_VMS_DISABLED_CODE }
        )
      }
      // A same-id twin on another host must not lend this repo its orca.yaml.
      if (store.getRepo(repo.id)?.path !== repo.path) {
        throw invalidArgument(ephemeralVmFailure('remoteRepoUnsupported').error)
      }
      // Only the repo's own orca.yaml recipes: plugin recipes are a separate namespace for the CLI.
      const resolved = resolveRecipeProvisionTarget(store, repo.id, params.recipeId, [])
      if (!resolved.ok) {
        throw invalidArgument(resolved.result.ok ? 'Recipe not found.' : resolved.result.error)
      }
      const { target } = resolved
      // The project the dialog gives the VM: the portable GitHub identity, else the source project.
      const projectId =
        resolvePortableRecipeProjectId(target.repo) ??
        getProjectHostSetupForRepo(store.getProjectHostSetups(), target.repo).projectId
      const projectProviderIdentity = store
        .getProjects()
        .find((project) => project.id === projectId)?.providerIdentity
      const checkoutMode = target.recipe.checkoutMode ?? 'orca-worktree'
      return createRecipeWorkspace(
        {
          params,
          checkoutMode,
          projectId,
          ...(projectProviderIdentity ? { projectProviderIdentity } : {}),
          ...options
        },
        {
          provision: (provisionOptions) =>
            provisionRecipeEnvironment(
              store,
              userDataPath(),
              target,
              {
                workspaceName: params.name,
                projectId,
                // The dialog's inputs for a recipe that checks out its own root.
                ...(checkoutMode === 'provisioned-root'
                  ? {
                      branch: params.branchNameOverride ?? params.name,
                      ...(params.baseBranch ? { ref: params.baseBranch } : {})
                    }
                  : {})
              },
              provisionOptions
            ),
          call: (environmentId, method, payload, callOptions) =>
            callRuntimeEnvironment(
              getRuntimeEnvironmentRegistryRoot(),
              `id:${environmentId}`,
              method,
              payload,
              callOptions.timeoutMs,
              undefined,
              undefined,
              callOptions.signal ? { signal: callOptions.signal } : undefined
            ),
          destroy: (runtimeId) => cleanupOwnedEphemeralVmRuntime(store, userDataPath(), runtimeId),
          attach: (runtimeId, workspaceId) => {
            attachEphemeralVmRuntimeToWorkspace({
              userDataPath: userDataPath(),
              runtimeId,
              workspaceId
            })
          },
          hideCheckout: hideMainVmCreateCheckout
        }
      )
    }
  })
}
