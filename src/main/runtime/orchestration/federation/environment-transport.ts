import { createHash } from 'node:crypto'
import { fingerprintAuthenticatedPairingCredential } from '../../rpc/server/pairing/device-principal'
import type {
  RuntimeRequestGuard,
  RuntimeRequestPreparation,
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

export type OrchestrationWorkerServer = {
  environmentId: string
  name: string
  peerFingerprint: string
  homePeerFingerprint?: string
  pairingRevision?: number
}

/** Callers that already proved the contract, or that pin the pairing generation they resolved against. */
export type OrchestrationEnvironmentCallOptions = {
  prepareRequest?: RuntimeRequestPreparation
  prepareGuard?: RuntimeRequestGuard
  contractVerified?: boolean
  expectedEnvironmentPairingRevision?: number
  /** Only send if this host already has a ready connection; never wake an idle or disconnected server. */
  readyOnly?: boolean
}

export type OrchestrationEnvironmentSendOptions = {
  prepareRequest?: RuntimeRequestPreparation
  prepareGuard?: RuntimeRequestGuard
  /** Send only to this host incarnation; any other answers runtime_environment_changed before sending. */
  expectedRuntimeId?: string
  /** Only send if this host already has a ready connection; never wake an idle or disconnected server. */
  readyOnly?: boolean
}

export type OrchestrationEnvironmentTransport = {
  resolve(selector: string): OrchestrationWorkerServer | Promise<OrchestrationWorkerServer>
  /** Every server paired to this host, by id and name. */
  list?(): Promise<readonly { environmentId: string; name: string }[]>
  /** False once the server is removed from this host, so its relays stop instead of retrying forever. */
  hasEnvironment?(environmentId: string): boolean | Promise<boolean>
  call(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope,
    expectedEnvironmentPairingRevision?: number,
    send?: OrchestrationEnvironmentSendOptions
  ): Promise<RuntimeRpcResponse<unknown>>
  /** Fires when a server's status turns verified, so backed-off relays retry at once. */
  onEnvironmentVerified?(listener: (environmentId: string) => void): () => void
}

export function fingerprintOrchestrationPeer(publicKeyB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('base64url')
}

/** How a home names a paired runtime and itself; the runtime derives the same pair from its own
 *  pairing key and from the home's credential when it authenticates the home's socket. */
export function pairedOrchestrationPeers(hostPublicKeyB64: string, deviceToken: string) {
  return {
    peerFingerprint: fingerprintOrchestrationPeer(hostPublicKeyB64),
    homePeerFingerprint: fingerprintAuthenticatedPairingCredential(deviceToken)
  }
}
