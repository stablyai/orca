// A cloud VM put to sleep somewhere else (the CLI, the phone, another window) still reads as
// running in this desktop's runtime record until Orca loses contact with it, minutes later. Until
// then the row shows it awake and every wake returns at once without resuming it. The control
// plane knows: whenever it says the sandbox is asleep while the record says running, the record
// changes to suspended, so the row reads Asleep and the next wake really resumes it.
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { findCloudRuntime } from './hosted-workspace-runtime'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'

/**
 * Marks `seen` (a running cloud record read before asking the control plane) suspended. Only when
 * the stored record is still exactly the one that was read: a wake or sleep of this app that
 * landed while the control plane answered wins. Returns the updated record, or null.
 */
export function markCloudRuntimeSleptElsewhere(
  userDataPath: string,
  seen: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord | null {
  if (seen.status !== 'running' || seen.recipe?.provider !== 'orca-cloud') {
    return null
  }
  const current = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === seen.id)
  if (!current || current.status !== 'running' || current.updatedAt !== seen.updatedAt) {
    return null
  }
  return updateEphemeralVmRuntimeStatus(userDataPath, seen.id, { status: 'suspended' })
}

/** The running Orca Cloud record for a sandbox id, as read now (before asking the control plane). */
export function findCloudRuntimeBySandboxId(
  userDataPath: string,
  sandboxId: string
): EphemeralVmRuntimeRecord | null {
  for (const runtime of listEphemeralVmRuntimes(userDataPath)) {
    if (
      runtime.recipe?.provider !== 'orca-cloud' ||
      runtime.status !== 'running' ||
      !runtime.recipeResult
    ) {
      continue
    }
    const handle = environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    if (handle?.driverState.sandboxId === sandboxId) {
      return runtime
    }
  }
  return null
}

/** A status read said `state`: asleep there but running here was slept from another client. */
export function noteCloudRuntimeRemoteState(
  deps: { userDataPath: string; syncSessions: () => void },
  seen: EphemeralVmRuntimeRecord,
  state: string
): void {
  if (state === 'sleeping' && markCloudRuntimeSleptElsewhere(deps.userDataPath, seen)) {
    // Its lease scheduler stops: the session it renewed is gone.
    deps.syncSessions()
  }
}

/** Whether the control plane says this workspace's sandbox is asleep; unknown counts as not. */
export async function isAsleepOnControlPlane(
  userDataPath: string,
  client: Pick<HostedSandboxControlPlaneClient, 'get'>,
  workspaceId: string
): Promise<boolean> {
  const found = findCloudRuntime(userDataPath, workspaceId)
  if (!found) {
    return false
  }
  try {
    return (await client.get(found.sandboxId)).status === 'suspended'
  } catch {
    // Unreachable: the wake goes on as before (lost contact still recovers it later).
    return false
  }
}

let asleepCheck: ((workspaceId: string) => Promise<boolean>) | null = null
/** Installed with Orca Cloud; a wake of a cloud VM recorded as running asks it first. */
export function setCloudAsleepCheck(
  check: ((workspaceId: string) => Promise<boolean>) | null
): void {
  asleepCheck = check
}
/** False when Orca Cloud is off in this build. */
export function isCloudWorkspaceAsleepOnControlPlane(workspaceId: string): Promise<boolean> {
  return asleepCheck ? asleepCheck(workspaceId) : Promise.resolve(false)
}
