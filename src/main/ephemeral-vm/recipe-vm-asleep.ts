import {
  findEnvironmentEphemeralVmRuntime,
  isEphemeralVmSuspended
} from '../../shared/ephemeral-vm-environment-sleep'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getRecipeVmWaker } from '../runtime/workspaces/sleep/recipe-vm-waker-registry'
import { getRuntimeOwnedSshTargetId } from '../ssh/targets/ssh-target-runtime-ownership'

/**
 * The one answer to "may Orca dial this VM in the background?" (#36363). A VM is asleep while its
 * record says suspended (or its resume failed) and no wake is under way. Background reconnects,
 * health probes and polling must not dial it then: a provider that resumes on a new SSH login or
 * connection would wake it, and the sleep would save nothing. A wake (opening the workspace,
 * Resume) is pending before it dials, so the wake's own connect passes. Why not while a suspend
 * runs: a suspend that then fails or is skipped leaves the VM up, and must not strand reconnects.
 */
function isVmAsleep(vm: EphemeralVmRuntimeRecord & { workspaceId: string }): boolean {
  if (!isEphemeralVmSuspended(vm)) {
    return false
  }
  const waker = getRecipeVmWaker()
  return waker ? waker.state(vm.workspaceId, true) !== 'waking' : true
}

/** Whether the server behind this environment is a recipe VM that is asleep. Never throws: an
 *  unknown environment or unreadable VM record must not strand a server that may be up. */
export async function prepareRecipeVmEnvironmentSleepCheck(
  userDataPath: string,
  environmentId: string
): Promise<() => boolean> {
  try {
    const environment = await resolveEnvironment(userDataPath, environmentId)
    return () => {
      try {
        const vm = findEnvironmentEphemeralVmRuntime(userDataPath, environment)
        return vm ? isVmAsleep(vm) : false
      } catch {
        return false
      }
    }
  } catch {
    return () => false
  }
}

export async function isRecipeVmEnvironmentAsleep(
  userDataPath: string,
  environmentId: string
): Promise<boolean> {
  return (await prepareRecipeVmEnvironmentSleepCheck(userDataPath, environmentId))()
}

/** Where desktop main keeps its VM and environment stores; unset on a host that holds no VMs. */
let storeRoot: (() => string) | null = null

export function setRecipeVmAsleepStoreRoot(root: (() => string) | null): void {
  storeRoot = root
}

/** `isRecipeVmEnvironmentAsleep` for transports that do not know the store root. */
export async function prepareRecipeVmServerSleepCheck(
  environmentId: string
): Promise<() => boolean> {
  let root: string
  try {
    if (!storeRoot) {
      return () => false
    }
    root = storeRoot()
  } catch {
    return () => false
  }
  return prepareRecipeVmEnvironmentSleepCheck(root, environmentId)
}

/** Whether this Orca-owned SSH host is the host of a recipe VM that is asleep. */
export function isRecipeVmSshTargetAsleep(userDataPath: string, targetId: string): boolean {
  // Why first: every other SSH host skips the VM store read.
  if (!isRuntimeOwnedSshTargetId(targetId)) {
    return false
  }
  const vm = listEphemeralVmRuntimes(userDataPath).find(
    (entry) =>
      (entry.sshTargetId === targetId || getRuntimeOwnedSshTargetId(entry.id) === targetId) &&
      entry.status !== 'cleaned' &&
      entry.status !== 'cleanup_pending'
  )
  return vm?.workspaceId ? isVmAsleep({ ...vm, workspaceId: vm.workspaceId }) : false
}
