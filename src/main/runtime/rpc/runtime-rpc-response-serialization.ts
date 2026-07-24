import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../shared/node-bounded-json-stringify'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'
import type { RpcResponse } from './core'
import { errorResponse } from './errors'

const RESPONSE_TOO_LARGE_MESSAGE = `RPC response exceeds ${REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES} bytes`

export function boundRuntimeRpcResponse(response: RpcResponse): RpcResponse {
  try {
    serializeWithinLimit(response)
    return response
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      return responseTooLargeError(response)
    }
    throw error
  }
}

export function serializeRuntimeRpcResponse(response: RpcResponse): string {
  try {
    return serializeWithinLimit(response)
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      return serializeWithinLimit(responseTooLargeError(response))
    }
    throw error
  }
}

function serializeWithinLimit(response: RpcResponse): string {
  return stringifyJsonWithinByteLimit(response, REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES).serialized
}

function responseTooLargeError(response: RpcResponse): RpcResponse {
  return errorResponse(
    response.id,
    response._meta,
    'response_too_large',
    RESPONSE_TOO_LARGE_MESSAGE
  )
}
