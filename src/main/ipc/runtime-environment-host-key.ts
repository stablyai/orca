import { createHash } from 'node:crypto'
import {
  getPreferredPairingOffer,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'

/**
 * The redacted record plus a digest of the host's E2EE public key. The host keeps that key in its
 * own profile across updates and proves it in every pairing handshake; a reinstalled or different
 * host has another. The renderer cannot see the key itself, so it compares this digest.
 */
export function publicRuntimeEnvironmentWithHostKey(
  environment: KnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  const publicKey = getPreferredPairingOffer(environment).publicKeyB64
  return {
    ...redactRuntimeEnvironment(environment),
    ...(publicKey
      ? { hostKeyFingerprint: createHash('sha256').update(publicKey).digest('hex').slice(0, 32) }
      : {})
  }
}
