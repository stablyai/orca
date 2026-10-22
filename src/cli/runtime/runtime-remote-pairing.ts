import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import { resolveEnvironmentPairingOffer } from './environments'
import { readRemoteEdgeAuthFile } from './remote-edge-auth-file'
import { RuntimeClientError } from './types'

export function resolveRemoteConnection(
  userDataPath: string,
  pairingCode: string | null,
  environmentSelector: string | null
): PairedRuntimeConnection | null {
  if (pairingCode && environmentSelector) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --pairing-code or --environment, not both.'
    )
  }
  if (environmentSelector) {
    return withEdgeAuth(
      pairedRuntimeConnectionFromOffer(
        resolveEnvironmentPairingOffer(userDataPath, environmentSelector)
      )
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
  return withEdgeAuth(pairedRuntimeConnectionFromOffer(pairing))
}

function withEdgeAuth(connection: PairedRuntimeConnection): PairedRuntimeConnection {
  const filePath = process.env.ORCA_REMOTE_AUTH_FILE
  return filePath
    ? { ...connection, edgeAuth: readRemoteEdgeAuthFile(filePath, connection) }
    : connection
}
