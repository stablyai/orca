import { createHash } from 'node:crypto'
import {
  getPreferredPairedRuntimeConnection,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'

/** Compare a digest of the persistent E2EE host key without exposing the key to the renderer. */
export function publicRuntimeEnvironmentWithHostKey(
  environment: KnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  const publicKey = getPreferredPairedRuntimeConnection(environment).hostPublicKeyB64
  return {
    ...redactRuntimeEnvironment(environment),
    ...(publicKey
      ? { hostKeyFingerprint: createHash('sha256').update(publicKey).digest('hex').slice(0, 32) }
      : {})
  }
}
