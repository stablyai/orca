import { formatSshUserDisconnectedMessage } from '../../../shared/ssh-user-disconnect-message'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'

/** Session-only disconnect blocks every background dial until explicit connect; restart clears both SSH and managed-server disconnects together. */
const userDisconnectedTargets = new Set<string>()
/** How many times the user has disconnected each target; explicit connects do not reset it. */
const userDisconnectCounts = new Map<string, number>()

export function recordSshUserDisconnected(targetId: string): void {
  userDisconnectedTargets.add(targetId)
  userDisconnectCounts.set(targetId, (userDisconnectCounts.get(targetId) ?? 0) + 1)
}

/** Work started before a Disconnect compares this count rather than the hold, which a connect in
 *  between may already have lifted. */
export function sshUserDisconnectCount(targetId: string): number {
  return userDisconnectCounts.get(targetId) ?? 0
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
  userDisconnectCounts.clear()
}

/** Not an auth or transient failure: callers neither ask for a sign-in nor retry it. */
export function createSshUserDisconnectedError(label: string): Error {
  return Object.assign(new Error(formatSshUserDisconnectedMessage(label)), {
    code: 'ssh_user_disconnected'
  })
}
