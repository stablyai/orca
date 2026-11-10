import type { SshTarget } from '../../../shared/ssh-types'

/** Legacy absence may mean explicit opt-out; pin existing hosts off once, then allow new hosts the default. */
export function migrateExistingHostsRemoteCliControl(
  targets: SshTarget[],
  alreadyMigrated: boolean,
  markNeedsSave: () => void
): SshTarget[] {
  if (alreadyMigrated) {
    return targets
  }
  // Persist the migration marker even when no hosts exist.
  markNeedsSave()
  return targets.map((target) =>
    target.allowRemoteCliControl === undefined
      ? { ...target, allowRemoteCliControl: false }
      : target
  )
}
