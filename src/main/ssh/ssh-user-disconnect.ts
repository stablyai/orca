import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'

/**
 * Hosts the user pressed Disconnect on. Until the user explicitly connects again, no background
 * dial (a managed server's tunnel or status check, a census, a pane or automation restore) may
 * reconnect them. Session-only, like a paired server's manual disconnect, so both halves of a
 * managed host are forgotten together at restart.
 */
const userDisconnectedTargets = new Set<string>()

export function recordSshUserDisconnected(targetId: string): void {
  userDisconnectedTargets.add(targetId)
}

export function isSshUserDisconnected(targetId: string): boolean {
  return userDisconnectedTargets.has(targetId)
}

/** Only an explicit user connect may lift it. */
export function clearSshUserDisconnected(targetId: string): void {
  userDisconnectedTargets.delete(targetId)
}

/** An explicit connect to a server reached over SSH is a connect of that SSH host too. */
export function clearSshUserDisconnectedForEnvironment(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'sshAccess'>
): void {
  const targetId = getRuntimeSshAccess(environment)?.sshTargetId
  if (targetId) {
    clearSshUserDisconnected(targetId)
  }
}

export function resetSshUserDisconnectsForTests(): void {
  userDisconnectedTargets.clear()
}

/** Not an auth or transient failure: callers neither ask for a sign-in nor retry it. */
export function createSshUserDisconnectedError(label: string): Error {
  return Object.assign(new Error(`${label} was disconnected. Connect to use it again.`), {
    code: 'ssh_user_disconnected'
  })
}
