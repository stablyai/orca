import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'
import { RUNTIME_OWNED_SSH_TARGET_ID_PREFIX } from '../../../shared/execution-host/execution-host'

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

export const MANAGED_HOST_REMOVAL_REFUSAL =
  'Orca runs on this host. Use Stop… under Settings › Orca on your SSH hosts to stop it and remove it from the host first, or Forget… there if the host is gone.'

type ManagedHostReference = Pick<SshTarget, 'orcadFence' | 'orcadProvisioning'>

export type ManagedHostRemovalDecision =
  | { kind: 'proceed' }
  | { kind: 'clear-dangling-reference' }
  | { kind: 'refuse' }

/** A missing catalog is `null` so removal stays refused. An empty set means the catalog was read and has no environments. */
export function decideManagedHostRemoval(
  target: ManagedHostReference | undefined,
  knownEnvironmentIds: ReadonlySet<string> | null
): ManagedHostRemovalDecision {
  if (!target || (target.orcadFence === undefined && target.orcadProvisioning === undefined)) {
    return { kind: 'proceed' }
  }
  if (knownEnvironmentIds === null) {
    return { kind: 'refuse' }
  }
  const ids = referencedManagedEnvironmentIds(target)
  if (ids === 'blank' || ids.length === 0 || ids.some((id) => knownEnvironmentIds.has(id))) {
    return { kind: 'refuse' }
  }
  return { kind: 'clear-dangling-reference' }
}

function referencedManagedEnvironmentIds(target: ManagedHostReference): string[] | 'blank' {
  const ids: string[] = []
  if (target.orcadFence !== undefined) {
    const fenceId = target.orcadFence.environmentId
    if (typeof fenceId !== 'string' || fenceId.trim() === '') {
      return 'blank'
    }
    ids.push(fenceId)
  }
  if (target.orcadProvisioning !== undefined) {
    const requestId = target.orcadProvisioning.requestId
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      return 'blank'
    }
    if (!ids.includes(requestId)) {
      ids.push(requestId)
    }
  }
  return ids
}

/** Managed hosts cannot serve direct relays unless older retained projects still require their previous relay. */
export function allowsDirectSshRelay(target: SshTarget): boolean {
  if (target.orcadProvisioning) {
    return false
  }
  return !target.orcadFence || target.orcadFence.sourceChangedAt !== undefined
}
