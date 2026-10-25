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
  // Why the enrolled grant: a restarted orcad offers a new device once this one has paired, and
  // taking it would change who this desktop is to the host (as WSL's #29042 found). Re-read: the
  // census may have repaired a refused pairing, or moved an unbindable tunnel port, meanwhile.
  const current = resolveEnvironment(userDataPath, environmentId)
  const localPort = getOrcadSshDeployment(current)?.localPort
  if (localPort === undefined) {
    throw new Error('This server is no longer managed over SSH.')
  }
  const enrolled = getPreferredPairingOffer(current)
  const pairingCode = tunneledOrcadPairingCode(readiness, localPort, enrolled)
  return refreshManagedOrcadPairing(userDataPath, environmentId, pairingCode)
}
