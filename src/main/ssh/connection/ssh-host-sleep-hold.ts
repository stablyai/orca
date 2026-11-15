import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'

/** Whether an Orca-owned SSH host serves a workspace VM that is asleep. Desktop main registers
 *  it; the SSH layer only reads it, so it stays free of the VM store. */
let asleepCheck: ((targetId: string) => boolean) | null = null

export function setSshHostAsleepCheck(check: ((targetId: string) => boolean) | null): void {
  asleepCheck = check
}

/** An asleep VM's SSH host takes no background login: some providers resume a paused VM on any
 *  SSH login, which would undo the sleep (#36363). Only a wake of the workspace lifts it. */
export function isSshHostHeldAsleep(targetId: string): boolean {
  if (!asleepCheck || !isRuntimeOwnedSshTargetId(targetId)) {
    return false
  }
  try {
    return asleepCheck(targetId)
  } catch {
    // An unreadable VM record must not strand a host that may be up.
    return false
  }
}

export const SSH_HOST_ASLEEP_ERROR_CODE = 'ssh_host_asleep'

/** Not an auth or transient failure: callers neither ask for a sign-in nor retry it. */
export function createSshHostAsleepError(label: string): Error {
  return Object.assign(
    new Error(`${label} is asleep. Open its workspace to wake it before connecting.`),
    { code: SSH_HOST_ASLEEP_ERROR_CODE }
  )
}
