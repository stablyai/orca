import type { SshTarget } from '../../shared/ssh-types'
import { isRuntimeOwnedSshTarget } from '../../shared/execution-host'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'

type SshConnectionIntent = NonNullable<SshTarget['desiredConnection']>

/** True while the user's own Disconnect holds this host down. Runtime-owned targets never are. */
export function isSshTargetDisconnectedByUser(targetId: string): boolean {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  return (
    target !== undefined &&
    !isRuntimeOwnedSshTarget(target) &&
    target.desiredConnection === 'disconnected'
  )
}

/**
 * Records what the user asked for on the target row itself, so it survives a restart and ends
 * with the target. Only a user's Connect or Disconnect may call this — a network drop is never
 * the user's intent (docs/reference/ssh-execution-boundary.md).
 */
export function recordSshConnectionIntent(targetId: string, intent: SshConnectionIntent): void {
  const store = getSshTargetRegistryStore()
  const target = store?.getTarget(targetId)
  // Why ownership: a runtime-owned target's lifecycle belongs to the runtime layer, not the user.
  if (!store || !target || isRuntimeOwnedSshTarget(target) || target.desiredConnection === intent) {
    return
  }
  store.updateTarget(targetId, { desiredConnection: intent })
}

export function sshTargetDisplayLabel(targetId: string): string {
  return getSshTargetRegistryStore()?.getTarget(targetId)?.label ?? targetId
}
