import {
  RUNTIME_ORDINARY_MESSAGE_CAPABILITY,
  RUNTIME_ORDINARY_MESSAGE_MAX_BYTES
} from '../../../src/shared/runtime-ordinary-message-capability'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../../src/shared/remote-runtime/remote-runtime-memory-limits'
import type { RpcResponse } from './types'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'

export function createMobileOrdinaryMessageSupport() {
  let supported = false
  return {
    reset() {
      supported = false
    },
    capacity: () =>
      supported
        ? RUNTIME_ORDINARY_MESSAGE_MAX_BYTES
        : REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES,
    observe<T extends RpcResponse>(
      method: string,
      response: T,
      current: boolean,
      envelope?: RpcEnvelopeFields
    ): T {
      if (
        method === 'status.get' &&
        current &&
        !envelope?.executionHost &&
        response.ok &&
        typeof response.result === 'object' &&
        response.result !== null &&
        'capabilities' in response.result &&
        Array.isArray(response.result.capabilities)
      ) {
        supported = response.result.capabilities.includes(RUNTIME_ORDINARY_MESSAGE_CAPABILITY)
      }
      return response
    }
  }
}
