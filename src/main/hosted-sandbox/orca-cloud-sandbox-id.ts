// The Orca Cloud sandbox id (the control plane's workspaceId) behind a runtime environment on this
// computer. Only an Orca Cloud runtime this desktop provisioned resolves, so the renderer can't name
// an arbitrary sandbox.
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'

export function orcaCloudSandboxIdFor(
  userDataPath: string,
  runtimeEnvironmentId: string
): string | null {
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (record) =>
      record.runtimeEnvironmentId === runtimeEnvironmentId &&
      // Composer-created cloud workspaces store the recipe without a provider (like
      // cloud-desktop-keys); the hosted-sandbox handle below is what proves it is Orca Cloud.
      (record.recipe?.provider === 'orca-cloud' || record.recipe?.provider === undefined)
  )
  const handle = runtime?.recipeResult
    ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    : null
  return handle?.environmentId ?? null
}
