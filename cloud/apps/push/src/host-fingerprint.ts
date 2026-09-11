import { createHash } from 'node:crypto'
import { PUSH_HOST_FINGERPRINT_LENGTH } from '@orca-cloud/push-contract'

// Identical derivation to deriveRelayHostId on the desktop, so a host and a
// phone reach the same fingerprint from the same X25519 public key.
export function deriveHostFingerprint(hostPublicKey: Uint8Array): string {
  return createHash('sha256')
    .update(hostPublicKey)
    .digest('base64url')
    .slice(0, PUSH_HOST_FINGERPRINT_LENGTH)
}

// Logs may carry at most this much of a fingerprint.
export function fingerprintLogPrefix(hostFingerprint: string): string {
  return hostFingerprint.slice(0, 4)
}
