import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  SSH_SIGN_IN_AWAITED_SUFFIX,
  SSH_SIGN_IN_CANCELLED_SUFFIX
} from '../../shared/ssh-sign-in-required-copy'

/** Suppress automatic prompts after decline until explicit connect; background status/tunnels/reconnects would otherwise reopen the modal repeatedly. */
// The declining attempt may try other methods; only later attempts are barred. awaitingSignIn records credentials not yet supplied this launch.
type SshCredentialDecline = { attempt: AbortSignal | undefined; awaitingSignIn: boolean }
const declinedTargets = new Map<string, SshCredentialDecline>()

export function recordSshCredentialDeclined(targetId: string, attempt?: AbortSignal): void {
  declinedTargets.set(targetId, { attempt, awaitingSignIn: false })
}

/** Remember required sign-in at launch so background reconnect cannot open prompts before user interaction. */
export function recordSshSignInAwaited(targetId: string): void {
  if (!declinedTargets.has(targetId)) {
    declinedTargets.set(targetId, { attempt: undefined, awaitingSignIn: true })
  }
}

/** Omit `attempt` to ask whether a new connect may be started at all. */
export function isSshCredentialDeclined(targetId: string, attempt?: AbortSignal): boolean {
  const decline = declinedTargets.get(targetId)
  if (!decline) {
    return false
  }
  return attempt === undefined || decline.attempt !== attempt
}

/** Only an explicit user connect, or a sign-in that succeeded anyway, may lift a decline. */
export function clearSshCredentialDeclined(targetId: string): void {
  declinedTargets.delete(targetId)
}

/** Explicit managed-server connect also signs into its SSH host. */
export function clearSshCredentialDeclinedForEnvironment(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'sshAccess'>
): void {
  const targetId = getRuntimeSshAccess(environment)?.sshTargetId
  if (targetId) {
    clearSshCredentialDeclined(targetId)
  }
}

export function resetSshCredentialDeclinesForTests(): void {
  declinedTargets.clear()
}

/** Classify as needs-sign-in, never a transient reconnect failure. */
export function createSshCredentialDeclinedError(targetId: string, label: string): Error {
  const message =
    declinedTargets.get(targetId)?.awaitingSignIn === true
      ? `${label} ${SSH_SIGN_IN_AWAITED_SUFFIX}`
      : `SSH sign-in for ${label} ${SSH_SIGN_IN_CANCELLED_SUFFIX}`
  return Object.assign(new Error(message), { level: 'client-authentication' })
}
