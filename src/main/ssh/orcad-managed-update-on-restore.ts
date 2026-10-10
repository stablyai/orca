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

const redeploying = new Map<string, Promise<boolean>>()

/**
 * Redeploys a server another desktop stopped while this session uses it, so the call that found it
 * stopped can still reach it. Not limited to once per session: a stop can come at any time.
 * Resolves true when a server was activated; concurrent callers share one attempt.
 */
export function redeployStoppedManagedOrcad(
  environmentId: string,
  createDeps: () => ManagedOrcadRestoreUpdateDeps
): Promise<boolean> {
  let attempt = redeploying.get(environmentId)
  if (!attempt) {
    attempt = runRedeploy(environmentId, createDeps).finally(() =>
      redeploying.delete(environmentId)
    )
    redeploying.set(environmentId, attempt)
  }
  return attempt
}

async function runRedeploy(
  environmentId: string,
  createDeps: () => ManagedOrcadRestoreUpdateDeps
): Promise<boolean> {
  try {
    const deps = createDeps()
    const target = deps.target(environmentId)
    if (!target) {
      return false
    }
    const { note, reason } = await checkManagedServerUpdate(target, environmentId, deps, () =>
      deps.publish(target, environmentId, 'updating')
    )
    deps.publish(target, environmentId, 'settled', note)
    return reason === 'updated'
  } catch (error) {
    console.warn('[ssh] Could not redeploy a stopped managed Orca server:', error)
    return false
  }
}

export function resetManagedOrcadRestoreUpdatesForTests(): void {
  checked.clear()
  redeploying.clear()
}
