import { recordSshSignInAwaited } from '../../ssh/ssh-credential-decline'
import type { SshConnectionManager } from '../../ssh/ssh-connection-manager'
import type { SshConnectionStore } from '../../ssh/ssh-connection-store'
import { credentialRequestedForTarget } from './ssh-connect-attempt-registry'

/**
 * Persists whether signing in to this host took a typed credential, so the next launch knows
 * which hosts must wait for the user instead of prompting from a background reconnect.
 */
export function recordSshSignInRequirement(
  targetId: string,
  store: SshConnectionStore | null,
  connectionManager: SshConnectionManager | null
): void {
  const asked = credentialRequestedForTarget.delete(targetId)
  const target = store?.getTarget(targetId)
  if (!target) {
    return
  }
  // A remembered password replayed without asking still means the host needs one.
  const required =
    asked || connectionManager?.getConnection(targetId)?.hasCachedCredential() === true
  if (target.lastRequiredPassphrase !== required) {
    store!.updateTarget(targetId, { lastRequiredPassphrase: required })
  }
}

/** At launch no credential is remembered; only the user's own connect may ask for one. */
export function awaitSignInForCredentialHosts(store: SshConnectionStore): void {
  // listTargets omits runtime-owned targets: the runtime layer dials those, never the user.
  for (const target of store.listTargets()) {
    if (target.lastRequiredPassphrase === true) {
      recordSshSignInAwaited(target.id)
    }
  }
}
