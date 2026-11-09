import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { ORCA_CLOUD_RECIPE_ID } from '../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { normalizeTypedName } from '../../shared/typed-name-normalization'
import { legacyOrcaCloudEnvironmentName } from '../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from '../../shared/remote-runtime/host-store/runtime-environment-store-file'

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
export function renameLegacyOrcaCloudEnvironments(
  userDataPath: string,
  runtimes: readonly LegacyRenameRuntime[]
): number {
  const renames = new Map<string, string>()
  for (const runtime of runtimes) {
    if (runtime.runtimeEnvironmentId && isOrcaCloudRuntime(runtime)) {
      renames.set(runtime.runtimeEnvironmentId, runtime.id)
    }
  }
  if (renames.size === 0) {
    return 0
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const taken = new Set(
    store.environments.map((environment) => normalizeTypedName(environment.name))
  )
  let renamed = 0
  const environments = store.environments.map((environment) => {
    const runtimeId = renames.get(environment.id)
    const next =
      environment.source === 'ephemeral-vm' && runtimeId
        ? legacyOrcaCloudEnvironmentName(environment.name, runtimeId)
        : null
    // Names stay unique: never take one another saved server already has.
    if (!next || taken.has(normalizeTypedName(next))) {
      return environment
    }
    taken.add(normalizeTypedName(next))
    renamed++
    return { ...environment, name: next }
  })
  if (renamed > 0) {
    writeEnvironmentStore(userDataPath, { ...store, environments })
  }
  return renamed
}
