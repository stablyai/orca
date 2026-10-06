import { track } from '../../telemetry/client'
import type { RpcEnvelopeMeta } from './core'
import { errorResponse } from './errors'

export const RPC_REPLY_TOO_LARGE_CODE = 'reply_too_large'
export const RPC_REPLY_TOO_LARGE_MESSAGE =
  'This response is too large to send over the remote connection.'

export type DispatcherReplySizeGuard = {
  reply: (response: string) => void
  /** For a streaming handler: aborts on the caller's signal, or when this request's reply overflowed. */
  streamSignal: () => AbortSignal | undefined
}

/** Why: a remote socket closes the whole connection on a reply over its frame cap, killing every
 *  stream on it. Fail only the request instead: one correlated error, then drop its later replies
 *  and abort its signal so a streaming handler releases its source. */
export function createDispatcherReplySizeGuard(args: {
  requestId: string
  meta: RpcEnvelopeMeta
  reply: (response: string) => void
  replyFitsTransport: ((response: string) => boolean) | undefined
  signal: AbortSignal | undefined
}): DispatcherReplySizeGuard {
  const { requestId, meta, reply, replyFitsTransport, signal } = args
  if (!replyFitsTransport) {
    return { reply, streamSignal: () => signal }
  }
  const overflow = new AbortController()
  let overflowed = false
  return {
    reply: (response) => {
      if (overflowed) {
        return
      }
      if (replyFitsTransport(response)) {
        reply(response)
        return
      }
      overflowed = true
      try {
        track('remote_outbound_budget_close', { emitter: 'reply-size' })
      } catch {
        // Telemetry is best-effort; failing the request remains authoritative.
      }
      reply(
        JSON.stringify(
          errorResponse(requestId, meta, RPC_REPLY_TOO_LARGE_CODE, RPC_REPLY_TOO_LARGE_MESSAGE)
        )
      )
      overflow.abort()
    },
    // Why: a linked child, not AbortSignal.any, so a handler that never removes its abort
    // listener cannot keep this request's state alive; the caller's signal is per-request.
    streamSignal: () => {
      if (signal?.aborted) {
        overflow.abort(signal.reason)
      } else {
        signal?.addEventListener('abort', () => overflow.abort(signal.reason), { once: true })
      }
      return overflow.signal
    }
  }
}
