import { createHash } from 'node:crypto'
import {
  getPreferredPairedRuntimeConnection,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

/** A digest of a paired server's persistent E2EE host key, safe to show the renderer or save. */
export function runtimeHostKeyFingerprint(publicKeyB64: string): string {
  return createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 32)
}

/** Compare a digest of the persistent E2EE host key without exposing the key to the renderer. */
export function publicRuntimeEnvironmentWithHostKey(
  environment: KnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  const publicKey = getPreferredPairedRuntimeConnection(environment).hostPublicKeyB64
  return {
    ...redactRuntimeEnvironment(environment),
    ...(publicKey ? { hostKeyFingerprint: runtimeHostKeyFingerprint(publicKey) } : {})
  }
}
