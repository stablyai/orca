import type {
  RegisterDeviceKeyParams,
  RegisterDeviceKeyResult
} from '../../../shared/device-key-registration-contract'
import { sanitizeDeviceLabel, verifyDeviceProof } from '../../../shared/device-key-proof'
import type { DeviceRegistry } from '../device-registry'
import type { AuthenticatedMobileSocket } from '../rpc/mobile-socket-wiring'

/**
 * Registers the calling installation's key by forking its token row (device-key-fork.ts). Proof of
 * possession is bound to this socket's v2 transcript, so a captured proof is useless elsewhere.
 */
export function registerSocketDeviceKey(
  registry: DeviceRegistry,
  socket: AuthenticatedMobileSocket,
  params: RegisterDeviceKeyParams
): RegisterDeviceKeyResult {
  if (!socket.transcriptHashB64) {
    throw new Error('device_key_requires_e2ee_v2')
  }
  if (
    !verifyDeviceProof({
      devicePublicKeyB64: params.devicePublicKeyB64,
      deviceProofB64: params.deviceProofB64,
      purpose: 'register',
      transcriptHashB64: socket.transcriptHashB64
    })
  ) {
    throw new Error('bad_proof')
  }
  const legacy = registry.resolveAuthenticatedPrincipal(socket.device)
  if (!legacy) {
    throw new Error('unauthorized')
  }
  const entry = registry.forkDeviceKey(
    legacy.deviceId,
    params.devicePublicKeyB64,
    sanitizeDeviceLabel(params.deviceLabel, legacy.name),
    { ephemeral: params.ephemeral === true }
  )
  return { deviceId: entry.deviceId, credentialRevision: entry.credentialRevision ?? 0 }
}
