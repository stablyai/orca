import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  SSH_SIGN_IN_AWAITED_SUFFIX,
  SSH_SIGN_IN_CANCELLED_SUFFIX
} from '../../shared/ssh-sign-in-required-copy'

/**
 * Hosts whose credential prompt the user cancelled (or left unanswered). Until the user explicitly
 * connects again, no automatic connect may prompt for them: background status checks, managed
 * server tunnels and reconnect ladders would otherwise reopen the modal every few seconds.
 */
// `attempt` is the declining attempt's credential signal: that attempt may still offer its other
// methods (a password after a cancelled passphrase), only later attempts are barred.
// `awaiting-sign-in`: the host needs a typed credential this run has not been given yet.
type SshCredentialDecline = { attempt: AbortSignal | undefined; awaitingSignIn: boolean }
const declinedTargets = new Map<string, SshCredentialDecline>()

export function recordSshCredentialDeclined(targetId: string, attempt?: AbortSignal): void {
  declinedTargets.set(targetId, { attempt, awaitingSignIn: false })
}

/**
 * At launch nothing is remembered, so background reconnects to a host that needs a typed
 * credential would open the sign-in dialog before the user touched that host.
 */
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

/** An explicit connect to a server reached over SSH is a sign-in to that SSH host too. */
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

/** Classified as an auth failure, so callers report "needs sign-in" and never retry it as transient. */
export function createSshCredentialDeclinedError(targetId: string, label: string): Error {
  const message =
    declinedTargets.get(targetId)?.awaitingSignIn === true
      ? `${label} ${SSH_SIGN_IN_AWAITED_SUFFIX}`
      : `SSH sign-in for ${label} ${SSH_SIGN_IN_CANCELLED_SUFFIX}`
  return Object.assign(new Error(message), { level: 'client-authentication' })
}
