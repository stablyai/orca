import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { resolveEnvironmentPairingOffer } from './environments'
import { RuntimeClientError } from './types'

/** Resolve which remote Orca runtime, if any, a CLI invocation targets. */
export function resolveRemotePairing(
  userDataPath: string,
  pairingCode: string | null,
  environmentSelector: string | null
): PairingOffer | null {
  if (pairingCode && environmentSelector) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --pairing-code or --environment, not both.'
    )
  }
  if (environmentSelector) {
    return resolveEnvironmentPairingOffer(userDataPath, environmentSelector)
  }
  if (!pairingCode) {
    return null
  }
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid remote pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  return pairing
}
