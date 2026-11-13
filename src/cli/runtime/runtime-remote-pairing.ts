import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { parsePairingCode } from '../../shared/remote-runtime/pairing/pairing'
import { resolveEnvironmentPairingOffer } from './environments'
import { RuntimeClientError } from './types'
import { configureRemoteRuntimeE2EEV2HostLatch } from '../../shared/remote-runtime/e2ee/node/remote-runtime-e2ee-v2-host-latch'

export async function resolveRemoteConnection(
  userDataPath: string,
  pairingCode: string | null,
  environmentSelector: string | null
): Promise<PairedRuntimeConnection | null> {
  const connection = await resolvePairedConnection(userDataPath, pairingCode, environmentSelector)
  if (connection) {
    // Why: the CLI and the desktop app share which hosts have proven E2EE v2.
    configureRemoteRuntimeE2EEV2HostLatch(userDataPath)
  }
  return connection
}

async function resolvePairedConnection(
  userDataPath: string,
  pairingCode: string | null,
  environmentSelector: string | null
): Promise<PairedRuntimeConnection | null> {
  if (pairingCode && environmentSelector) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --pairing-code or --environment, not both.'
    )
  }
  if (environmentSelector) {
    return pairedRuntimeConnectionFromOffer(
      await resolveEnvironmentPairingOffer(userDataPath, environmentSelector)
    )
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
  return pairedRuntimeConnectionFromOffer(pairing)
}
