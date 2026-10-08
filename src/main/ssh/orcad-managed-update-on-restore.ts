/**
 * The launch-time tunnel restore reaches a managed server without an SSH connect, so it runs the
 * same update check a connect would, once per server per session and off the caller's path.
 */
import type { SshManagedServerUpdateNote, SshTarget } from '../../shared/ssh-types'
import {
  checkManagedServerUpdate,
  type ManagedServerUpdateDeps
} from './managed-server-update-check'

export type ManagedOrcadRestoreUpdateDeps = ManagedServerUpdateDeps & {
  /** The SSH target that serves this managed server, or null when it is gone or unlinked. */
  target: (environmentId: string) => SshTarget | null
  /** Records the outcome so the host's status line can show it. */
  publish: (
    target: SshTarget,
    environmentId: string,
    phase: 'updating' | 'settled',
    note?: SshManagedServerUpdateNote
  ) => void
}

const checked = new Set<string>()

/** Resolves when the check settles; null when this session already checked the server. */
export function updateManagedOrcadOnRestore(
  environmentId: string,
  createDeps: () => ManagedOrcadRestoreUpdateDeps
): Promise<void> | null {
  if (checked.has(environmentId)) {
    return null
  }
  checked.add(environmentId)
  let deps: ManagedOrcadRestoreUpdateDeps
  let target: SshTarget | null
  try {
    deps = createDeps()
    target = deps.target(environmentId)
  } catch (error) {
    console.warn('[ssh] Update check on tunnel restore skipped:', error)
    return null
  }
  if (!target) {
    return null
  }
  return checkManagedServerUpdate(target, environmentId, deps, () =>
    deps.publish(target, environmentId, 'updating')
  ).then(
    ({ note }) => deps.publish(target, environmentId, 'settled', note),
    (error: unknown) => {
      console.warn('[ssh] Update check on tunnel restore failed:', error)
    }
  )
}

export function resetManagedOrcadRestoreUpdatesForTests(): void {
  checked.clear()
}
