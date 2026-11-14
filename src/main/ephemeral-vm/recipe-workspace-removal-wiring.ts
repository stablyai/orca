import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RECIPE_REMOVAL_REQUEST_TIMEOUT_MS } from '../../shared/recipe-host-removal'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import { cleanupOwnedEphemeralVmRuntime } from './owned-runtime-cleanup'
import {
  describeRecipeWorkspaceEnvironments,
  ownsRecipeWorkspaceRemoval,
  removeRecipeWorkspace
} from './workspace-removal'

/** Desktop-only: removing a recipe workspace from a phone or another client destroys its VM here. */
export function wireRecipeWorkspaceRemoval(
  runtime: OrcaRuntimeService,
  store: Store,
  userDataPath: () => string
): void {
  runtime.setRecipeWorkspaceRemoval({
    owns: (params) => ownsRecipeWorkspaceRemoval(userDataPath(), params),
    describe: (hostId) => describeRecipeWorkspaceEnvironments(userDataPath(), hostId),
    remove: (params) =>
      runtime.removeRecipeWorkspaceVm(
        params.worktree.slice('id:'.length),
        params.hostId ?? '',
        {
          force: params.force === true,
          runHooks: params.runHooks === true,
          allowFailedArchiveHook: params.allowFailedArchiveHook === true
        },
        (orderDestroy) =>
          removeRecipeWorkspace(
            userDataPath(),
            params,
            {
              call: (environmentId, method, payload) =>
                callRuntimeEnvironment(
                  getRuntimeEnvironmentRegistryRoot(),
                  `id:${environmentId}`,
                  method,
                  payload,
                  RECIPE_REMOVAL_REQUEST_TIMEOUT_MS
                ),
              cleanup: (runtimeId) =>
                cleanupOwnedEphemeralVmRuntime(store, userDataPath(), runtimeId)
            },
            orderDestroy
          )
      )
  })
}
