import type { RpcResponse } from './types'
import type {
  AnyRpcOperation,
  RpcDecodeIssue,
  RpcRequestOutcome,
  RpcSalvageReport
} from './rpc-operation-contract'
import {
  isStreamingOpenerReply,
  requireRpcResultOrThrowCodedError,
  rpcObjectResultOrNull
} from './rpc-acceptance-policies'

const NOTHING_SALVAGED: RpcSalvageReport = { droppedPaths: [], droppedCount: 0 }

type AdmittedPayload =
  | { readonly admitted: true; readonly value: unknown }
  | { readonly admitted: false; readonly issues: readonly RpcDecodeIssue[] }

// The payload the operation's own acceptance policy admits from a fulfilled success.
function admitPayload(operation: AnyRpcOperation, response: RpcResponse): AdmittedPayload {
  switch (operation.acceptance) {
    case 'object-result-or-null': {
      const object = rpcObjectResultOrNull(response)

      return object === null
        ? { admitted: false, issues: [{ path: 'result', message: 'not a non-null object' }] }
        : { admitted: true, value: object }
    }

    case 'streaming-opener':
      return isStreamingOpenerReply(response)
        ? { admitted: true, value: response }
        : { admitted: false, issues: [{ path: 'streaming', message: 'reply opened no stream' }] }
    default:
      // Reuses the policy rather than reading `.result` again; a success never throws here.
      return { admitted: true, value: requireRpcResultOrThrowCodedError(response) }
  }
}

const READERLESS_VARIANTS: Record<string, string> = {
  'method-not-found-refusal': 'accepted',
  'streaming-opener': 'stream-opened'
}

export function classifyRpcReply(
  operation: AnyRpcOperation,
  response: RpcResponse
): RpcRequestOutcome<string, unknown> {
  if (!response.ok) {
    return { kind: 'outer-refused', error: response.error, raw: response }
  }

  const payload = admitPayload(operation, response)

  if (!payload.admitted) {
    return { kind: 'incompatible', raw: response, issues: payload.issues }
  }

  const read = operation.read

  if (!read) {
    return {
      kind: 'decoded',
      variant: READERLESS_VARIANTS[operation.acceptance] ?? 'accepted',
      value: payload.value,
      raw: response,
      salvage: NOTHING_SALVAGED
    }
  }

  let result: ReturnType<typeof read>

  try {
    result = read(payload.value)
  } catch (error) {
    // These legacy policies preserve property-read exceptions at the caller's barrier.
    if (
      operation.acceptance === 'success-result-or-skip' ||
      operation.acceptance === 'require-result-or-throw-message'
    ) {
      throw error
    }

    return {
      kind: 'incompatible',
      raw: response,
      issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }]
    }
  }

  if (!result.compatible) {
    return { kind: 'incompatible', raw: response, issues: result.issues }
  }

  return {
    kind: 'decoded',
    variant: result.variant,
    value: result.value,
    raw: response,
    salvage: result.salvage
  }
}
