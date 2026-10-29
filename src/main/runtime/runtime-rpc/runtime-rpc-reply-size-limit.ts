import type { RpcResponse } from '../rpc/core'
import { isMobileE2EETextPayloadWithinLimit } from '../rpc/mobile-e2ee-outbound-admission'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'

export const RUNTIME_RPC_REPLY_TOO_LARGE_CODE = 'reply_too_large'

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Return a per-request oversize error before encrypted-channel 1013 would close the socket and every sibling RPC. */
export function limitRuntimeRpcReplySize(
  requestId: string,
  reply: (response: string) => void,
  buildError: (id: string, code: string, message: string) => RpcResponse
): (response: string) => void {
  return (response) => {
    if (isMobileE2EETextPayloadWithinLimit(response)) {
      reply(response)
      return
    }
    const bytes = Buffer.byteLength(response, 'utf8')
    reply(
      JSON.stringify(
        buildError(
          requestId,
          RUNTIME_RPC_REPLY_TOO_LARGE_CODE,
          `The result (${formatMebibytes(bytes)}) is larger than the ${formatMebibytes(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)} a remote connection can carry in one reply.`
        )
      )
    )
  }
}
