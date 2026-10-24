import type { SshTarget } from '../../../shared/ssh-types'

/**
 * Builds before the on-by-default flip saved an explicit "off" as absent, so an absent switch on a
 * host that existed before this upgrade may be a deliberate opt-out. Pin those off once; hosts
 * added afterwards keep absent=on via `isRemoteCliControlAllowed`.
 */
export function migrateExistingHostsRemoteCliControl(
  targets: SshTarget[],
  alreadyMigrated: boolean,
  markNeedsSave: () => void
): SshTarget[] {
  if (alreadyMigrated) {
    return targets
  }
  // Why always save: the marker itself must reach disk, even with no hosts to pin.
  markNeedsSave()
  return targets.map((target) =>
    target.allowRemoteCliControl === undefined
      ? { ...target, allowRemoteCliControl: false }
      : target
  )
}
