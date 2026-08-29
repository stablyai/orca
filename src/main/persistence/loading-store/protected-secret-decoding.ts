import { normalizeProxyUrl } from '../../../shared/network-proxy'
import { normalizeKagiSessionLink } from '../../../shared/browser-url'
import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import {
  PROTECTED_SECRET_SLOT,
  sshPtyOwnerLeaseSecretSlot,
  type ProtectedSecretPersistence
} from '../../protected-secret-persistence'
import {
  isLegacyOpenCodeSessionCookie,
  isLegacySshPtyOwnerLease
} from '../leasing-ssh-ptys/secret-validation'
import { normalizeSshPtyConsumerRecovery } from '../leasing-ssh-ptys/ssh-normalization'

/**
 * The per-slot decode rules, shared by the load boundary and the deferred hydration that
 * finishes the slots the load skipped. Why shared and not duplicated: the two paths must
 * agree on what an undecryptable value means, and a second copy would drift silently.
 */
export type ProtectedSecretDecoder = Pick<
  ProtectedSecretPersistence,
  'decrypt' | 'decryptWithStatus' | 'removeRetainedBlob'
>

export function decodeOpencodeSessionCookie(
  secrets: ProtectedSecretDecoder,
  ciphertext: string
): string {
  return secrets.decrypt(
    PROTECTED_SECRET_SLOT.opencodeSessionCookie,
    ciphertext,
    isLegacyOpenCodeSessionCookie
  )
}

export function decodeBrowserKagiSessionLink(
  secrets: ProtectedSecretDecoder,
  ciphertext: string
): string {
  return secrets.decrypt(
    PROTECTED_SECRET_SLOT.browserKagiSessionLink,
    ciphertext,
    (value) => normalizeKagiSessionLink(value) !== null
  )
}

/** `cleared` means the retained ciphertext was dropped, so the caller must persist the clear. */
export function decodeHttpProxyUrl(
  secrets: ProtectedSecretDecoder,
  ciphertext: string
): { value: string; cleared: boolean } {
  const decrypted = secrets.decryptWithStatus(
    PROTECTED_SECRET_SLOT.httpProxyUrl,
    ciphertext,
    (value) => normalizeProxyUrl(value).ok
  )
  // Why (STA-3442): after a keychain reset decrypt returns raw ciphertext; a non-URL
  // value must not masquerade as a configured proxy (silent DIRECT fallback) or
  // re-persist as garbage. Plaintext URLs still pass, preserving the upgrade path.
  if (
    decrypted.status === 'unavailable' ||
    (decrypted.status === 'failed' && !decrypted.plaintext)
  ) {
    return { value: '', cleared: false }
  }
  if (normalizeProxyUrl(decrypted.plaintext).ok) {
    return { value: decrypted.plaintext, cleared: false }
  }
  console.warn(
    '[persistence] httpProxyUrl could not be decrypted — clearing the stored proxy URL. Re-enter it in Settings > Advanced > Network.'
  )
  secrets.removeRetainedBlob(PROTECTED_SECRET_SLOT.httpProxyUrl)
  return { value: '', cleared: true }
}

/** Null drops the record entirely; the caller must filter it out of the recovery list. */
export function decodeSshPtyOwnerLease(
  secrets: ProtectedSecretDecoder,
  record: SshPtyConsumerRecovery
): SshPtyConsumerRecovery | null {
  const slot = sshPtyOwnerLeaseSecretSlot(record.targetId)
  const decrypted = secrets.decryptWithStatus(slot, record.ownerLease, isLegacySshPtyOwnerLease)
  // Why the record unchanged on 'unavailable': the lease stays sealed, and replacing it with
  // the empty plaintext would discard a live owner claim we can still re-read later.
  const normalized =
    decrypted.status === 'unavailable' || (decrypted.status === 'failed' && !decrypted.plaintext)
      ? record
      : normalizeSshPtyConsumerRecovery({ ...record, ownerLease: decrypted.plaintext })
  if (!normalized) {
    secrets.removeRetainedBlob(slot)
  }
  return normalized
}
