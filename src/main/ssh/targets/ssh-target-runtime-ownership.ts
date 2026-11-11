import type { SshTarget } from '../../../shared/ssh-types'
import { RUNTIME_OWNED_SSH_TARGET_ID_PREFIX } from '../../../shared/execution-host'

export function getRuntimeOwnedSshTargetId(runtimeId: string): string {
  return `${RUNTIME_OWNED_SSH_TARGET_ID_PREFIX}${runtimeId}`
}

/** Any target Orca created as an implementation detail; hidden from SSH-host surfaces. */
export function isRuntimeOwnedSshTarget(target: SshTarget): boolean {
  return target.owner !== undefined
}

/** A host serving (or being set up for) a managed Orca server: visible, but never a direct relay. */
export function isManagedOrcadSshTarget(target: SshTarget): boolean {
  return target.orcadFence !== undefined || target.orcadProvisioning !== undefined
}

/** Managed hosts cannot serve direct relays unless older retained projects still require their previous relay. */
export function allowsDirectSshRelay(target: SshTarget): boolean {
  if (target.orcadProvisioning) {
    return false
  }
  return !target.orcadFence || target.orcadFence.sourceChangedAt !== undefined
}
