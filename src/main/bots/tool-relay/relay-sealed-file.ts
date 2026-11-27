// Sealing relay secrets at rest with the OS keychain, and the shared retry limit for ones it refused.
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'

/**
 * Only a store sealed by the real OS keychain keeps a token at rest: not Linux `basic_text`, and not
 * a mock keychain (a test switch), which seals with a fixed password.
 */
export function relaySealingProtected(): boolean {
  if (!hasSecretStore()) {
    return false
  }
  const store = getSecretStore()
  return (
    store.isEncryptionAvailable() &&
    store.describeSealing?.().kind === 'os-keychain' &&
    store.mockKeychain?.() !== true
  )
}

export async function sealRelaySecret(plain: string): Promise<string> {
  const store = getSecretStore()
  const sealed = store.encryptStringAsync
    ? await store.encryptStringAsync(plain)
    : store.encryptString(plain)
  return sealed.toString('base64')
}

/** Rejects while the keychain can't open it (locked, or another app's key). */
export async function unsealRelaySecret(sealed: string): Promise<string> {
  const store = getSecretStore()
  const cipher = Buffer.from(sealed, 'base64')
  return store.decryptStringAsync
    ? await store.decryptStringAsync(cipher)
    : store.decryptString(cipher)
}

/** How often entries the keychain refused may be retried. */
export const RELAY_UNLOCK_RETRY_MS = 10_000

/** One retry of keychain-refused entries per `RELAY_UNLOCK_RETRY_MS` across every kept relay file. */
export class RelayUnlockThrottle {
  private last = Number.NEGATIVE_INFINITY

  constructor(private readonly now: () => number = Date.now) {}

  due(): boolean {
    if (this.now() - this.last < RELAY_UNLOCK_RETRY_MS) {
      return false
    }
    this.last = this.now()
    return true
  }
}

export const relayUnlockThrottle = new RelayUnlockThrottle()
