import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import {
  RemoteRuntimeClientError,
  sendRemoteRuntimeRequest
} from '../../shared/remote-runtime-client'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

export async function sendWebSocketRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequest<TResult>(pairing, method, params, timeoutMs, envelope)
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message)
    }
    throw error
  }
}
