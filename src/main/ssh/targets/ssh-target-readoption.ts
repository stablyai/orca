import type { Store } from '../../persistence'
import type {
  RemovedSshTargetTombstone,
  SshRepoReadoption,
  SshTarget
} from '../../../shared/ssh-types'
import { meaningfulSshAlias, sshEndpointKey, type SshIdentityFields } from './ssh-target-identity'

/** Re-add mints a new target id; tombstone identity matches reattach orphaned workspace/automation/filter state. Match aliases strictly, then endpoint tuples only when an alias is absent; uncertain ghosts remain for Forget. */

function tombstoneMatches(
  tombstone: RemovedSshTargetTombstone,
  target: SshIdentityFields
): boolean {
  const targetAlias = meaningfulSshAlias(target)
  const tombstoneAlias = meaningfulSshAlias(tombstone)
  if (targetAlias && tombstoneAlias) {
    // Distinct real aliases are distinct targets; never fall through and steal another alias's workspaces.
    return targetAlias === tombstoneAlias
  }
  return sshEndpointKey(tombstone) === sshEndpointKey(target)
}

/** Return exact migrations for renderer stale-row removal after host catalog merge; consume matches only when no dependents retain removal evidence. */
export function readoptOrphanedWorkspacesForTarget(
  store: Store,
  newTarget: SshTarget
): SshRepoReadoption[] {
  const tombstones = store.getRemovedSshTargetTombstones()
  if (tombstones.length === 0) {
    return []
  }
  const readoptions: SshRepoReadoption[] = []
  for (const tombstone of tombstones) {
    // Never re-point a still-live target onto itself, even if persisted evidence is inconsistent.
    if (tombstone.oldTargetId === newTarget.id) {
      store.releaseRemovedSshTargetTombstone(tombstone.oldTargetId)
      continue
    }
    if (!tombstoneMatches(tombstone, newTarget)) {
      continue
    }
    const repoIds = store.reassignSshTargetId(tombstone.oldTargetId, newTarget.id)
    if (repoIds.length > 0) {
      readoptions.push({ oldTargetId: tombstone.oldTargetId, newTargetId: newTarget.id, repoIds })
    }
    // Release consumed evidence only when automations/host filters no longer depend on it.
    store.releaseRemovedSshTargetTombstone(tombstone.oldTargetId)
  }
  return readoptions
}

export function buildRemovedSshTargetTombstone(
  target: SshTarget,
  removedAt: number
): RemovedSshTargetTombstone {
  return {
    oldTargetId: target.id,
    ...(target.configHost ? { configHost: target.configHost } : {}),
    host: target.host,
    port: target.port,
    username: target.username,
    label: target.label,
    removedAt
  }
}
