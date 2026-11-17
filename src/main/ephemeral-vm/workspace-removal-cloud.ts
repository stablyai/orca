// Orca Cloud's part of deleting a recipe workspace (workspace-removal.ts): deleting the workspace
// means deleting its sandbox, so every refusal happens before anything was touched and says so
// (Try again is safe).
import type { EphemeralVmRuntimeRecord } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import {
  CLOUD_DELETE_NOT_SENT,
  CLOUD_DELETE_NOT_SENT_IN_USE,
  CLOUD_DELETE_NOT_SENT_NO_DESTROY,
  CLOUD_DELETE_NOT_SENT_UNCHECKED,
  RecipeWorkspaceRemovalError
} from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-host-removal'

function noDestroyError(runtime: EphemeralVmRuntimeRecord): RecipeWorkspaceRemovalError {
  return new RecipeWorkspaceRemovalError(CLOUD_DELETE_NOT_SENT, CLOUD_DELETE_NOT_SENT_NO_DESTROY, {
    runtimeId: runtime.id
  })
}

/** Whether this is an Orca Cloud workspace; throws when nothing would destroy its sandbox. */
export function refuseCloudDeleteWithoutDestroy(runtime: EphemeralVmRuntimeRecord): boolean {
  const isOrcaCloud = runtime.recipe?.provider === 'orca-cloud'
  if (isOrcaCloud && (runtime.recipe?.destroyDisabled || runtime.cleanupStatus === 'disabled')) {
    // Nothing would destroy the sandbox, so refuse before touching anything.
    throw noDestroyError(runtime)
  }
  return isOrcaCloud
}

/** Proves an Orca Cloud sandbox is this workspace's alone before its checkout is removed. */
export async function refuseCloudDeleteUnlessAlone(
  isOrcaCloud: boolean,
  runtime: EphemeralVmRuntimeRecord,
  otherWorkspaces: () => Promise<unknown[] | undefined>
): Promise<void> {
  if (!isOrcaCloud) {
    return
  }
  const others = await otherWorkspaces()
  if (!others || others.length > 0) {
    throw new RecipeWorkspaceRemovalError(
      CLOUD_DELETE_NOT_SENT,
      others ? CLOUD_DELETE_NOT_SENT_IN_USE : CLOUD_DELETE_NOT_SENT_UNCHECKED,
      { runtimeId: runtime.id }
    )
  }
}

/** Guard only (checked up front): a "cleaned" Orca Cloud record without a destroy is never "Deleted". */
export function refuseCloudCleanedWithoutDestroy(
  isOrcaCloud: boolean,
  runtime: EphemeralVmRuntimeRecord,
  cleaned: EphemeralVmRuntimeRecord
): void {
  if (isOrcaCloud && cleaned.cleanupStatus === 'disabled') {
    throw noDestroyError(runtime)
  }
}
