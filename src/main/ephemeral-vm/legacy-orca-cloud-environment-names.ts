import type { EphemeralVmRuntimeRecord } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import { ORCA_CLOUD_RECIPE_ID } from '../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { renameLegacyOrcaCloudEnvironmentNames } from '../../shared/remote-runtime/host-store/runtime-environment-legacy-cloud-names'

/** The fields of a runtime record the rename reads. */
export type LegacyRenameRuntime = Pick<
  EphemeralVmRuntimeRecord,
  'id' | 'recipeId' | 'runtimeEnvironmentId'
> &
  Partial<Pick<EphemeralVmRuntimeRecord, 'recipe'>>

function isOrcaCloudRuntime(runtime: LegacyRenameRuntime): boolean {
  return runtime.recipe?.provider === 'orca-cloud' || runtime.recipeId === ORCA_CLOUD_RECIPE_ID
}

/**
 * Early builds saved an Orca Cloud server as "<repo> VM <id tail>", so the sidebar showed it as a
 * raw VM. Renames those to the "<repo> sandbox <id tail>" form every surface shows as "Orca Cloud".
 * Only servers an Orca Cloud runtime record points at are touched; custom recipe VMs keep "VM".
 */
export async function renameLegacyOrcaCloudEnvironments(
  userDataPath: string,
  runtimes: readonly LegacyRenameRuntime[]
): Promise<number> {
  const renames = new Map<string, string>()
  for (const runtime of runtimes) {
    if (runtime.runtimeEnvironmentId && isOrcaCloudRuntime(runtime)) {
      renames.set(runtime.runtimeEnvironmentId, runtime.id)
    }
  }
  if (renames.size === 0) {
    return 0
  }
  // The saved-server store is owned by its worker; the rename runs there.
  return renameLegacyOrcaCloudEnvironmentNames(userDataPath, [...renames])
}
