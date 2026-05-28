import type { PairingOffer } from '../../shared/pairing'
import {
  RemoteRuntimeClientError,
  sendRemoteRuntimeRequest
} from '../../shared/remote-runtime-client'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'

export async function sendWebSocketRequest<TResult>(
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<RuntimeRpcResponse<TResult>> {
  try {
    return await sendRemoteRuntimeRequest<TResult>(pairing, method, params, timeoutMs)
  } catch (error) {
    if (error instanceof RemoteRuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message)
    }
    throw error
  }
}
