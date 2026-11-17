// Orca Cloud's part of the recipe VM IPC (ephemeral-vm.ts): its handlers, the provider recipes
// it adds to every recipe list, and its refusals before a provision starts.
import type { Store } from '../persistence/loading-store/store'
import type { PluginService } from '../plugins/plugin-service'
import type { EphemeralVmFailure } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-failure-copy'
import type { OrcaCloudAvailability } from '../../shared/workspace-setup/orca-yaml-hook-types'
import { registerCloudCreatePhaseNotes } from './cloud-create-phase-timing'
import {
  getOrcaCloudAvailability,
  installHostedSandbox,
  withProviderRecipes
} from '../hosted-sandbox/hosted-sandbox-install'
import { missingRecipeFailure } from './orca-cloud-missing-recipe'
import { registerRecipeForwardedEnvHandler } from './ephemeral-vm-forwarded-env'
import {
  listRecipes,
  type EphemeralVmRecipeListResult
} from './ephemeral-vm/ephemeral-vm-recipe-context'

export { noteCloudCreatePhase, noteCloudCreateProvisionChunk } from './cloud-create-phase-timing'
export { refuseOrcaCloudWithoutGithub } from '../hosted-sandbox/hosted-sandbox-recipe'
export { buildEphemeralEnvironmentName } from './ephemeral-vm-recipe-context-cloud'
export { withProviderRecipes }

/** The provision IPC's args; Orca Cloud adds its idempotency key. */
export type EphemeralVmProvisionArgs = {
  repoId: string
  recipeId: string
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  branch?: string
  ref?: string
  provisionId?: string
  /** Orca Cloud: the Create press's key; a re-fired create gets the first one's sandbox. */
  idempotencyKey?: string
}

/** Registers Orca Cloud's handlers beside the recipe VM ones (and the recipe-host env summary). */
export function registerEphemeralVmCloudHandlers(store: Store): void {
  registerCloudCreatePhaseNotes()
  installHostedSandbox(store)
  registerRecipeForwardedEnvHandler(store)
}

/** The Run-on picker's list, plus Orca Cloud availability so it can offer sign-in or an upsell. */
export async function listPickerRecipes(
  store: Store,
  repoId: string,
  pluginService?: PluginService
): Promise<EphemeralVmRecipeListResult & { orcaCloud: OrcaCloudAvailability }> {
  const orcaCloud = await getOrcaCloudAvailability()
  return {
    ...listRecipes(store, repoId, await withProviderRecipes(pluginService, orcaCloud)),
    orcaCloud
  }
}

/** Why a provision found no recipe (Orca Cloud says "sign in" rather than "not found"). */
export function provisionRecipeMissing(
  recipeId: string
): Promise<EphemeralVmFailure> | EphemeralVmFailure {
  return missingRecipeFailure(recipeId, getOrcaCloudAvailability)
}
