import { recordSshSignInAwaited } from '../../ssh/ssh-credential-decline'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { SshConnectionStore } from '../../ssh/connection/ssh-connection-store'
import { credentialRequestedForTarget } from './ssh-connect-attempt-registry'

/** Persist credential need so background restore waits for explicit sign-in after the next launch. */
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

/** Credential hosts wait for explicit sign-in because credentials are not retained across launch. */
export function awaitSignInForCredentialHosts(store: SshConnectionStore): void {
  for (const target of store.listTargets()) {
    if (target.lastRequiredPassphrase === true) {
      recordSshSignInAwaited(target.id)
    }
  }
}
