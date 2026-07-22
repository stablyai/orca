import { createHash } from 'node:crypto'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'

export type OrchestrationWorkerServer = {
  environmentId: string
  name: string
  peerFingerprint: string
}

export type OrchestrationEnvironmentTransport = {
  resolve(selector: string): OrchestrationWorkerServer
  call(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope
  ): Promise<RuntimeRpcResponse<unknown>>
}

export function fingerprintOrchestrationPeer(publicKeyB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('base64url')
}
