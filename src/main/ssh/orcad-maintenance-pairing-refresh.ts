import { refreshManagedOrcadPairing } from '../../shared/runtime-environment-managed-orcad-store'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { ServeReadiness } from '../server/serve-readiness'
import { tunneledOrcadPairingCode } from './orcad-tunneled-pairing'

/** Saves the pairing a managed server published after an update, rollback or restart. */
export function refreshMaintainedOrcadPairing(
  userDataPath: string,
  environmentId: string,
  readiness: ServeReadiness
): KnownRuntimeEnvironment {
  // Reuse the enrolled grant after restart so pairing cannot replace this desktop’s identity (#29042).
  // Re-read because census may have repaired pairing or moved the tunnel port meanwhile.
  const current = resolveEnvironment(userDataPath, environmentId)
  const localPort = getOrcadSshDeployment(current)?.localPort
  if (localPort === undefined) {
    throw new Error('This server is no longer managed over SSH.')
  }
  const enrolled = getPreferredPairingOffer(current)
  const pairingCode = tunneledOrcadPairingCode(readiness, localPort, enrolled)
  return refreshManagedOrcadPairing(userDataPath, environmentId, pairingCode)
}
