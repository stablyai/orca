import { randomUUID } from 'node:crypto'
import {
  RUNTIME_RPC_READ_STAGED_REPLY_METHOD,
  RUNTIME_RPC_REPLY_STAGED_CODE,
  RUNTIME_RPC_MAX_STAGED_REPLY_BYTES,
  RUNTIME_RPC_STAGED_REPLY_CLIENT_CAPABILITY,
  RUNTIME_RPC_STAGED_REPLY_PART_CHARS,
  RuntimeRpcReadStagedReplyParamsSchema,
  type RuntimeRpcStagedReplyHandle
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-staged-reply'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'
import type { RpcEnvelopeMeta, RpcRequest, RpcResponse } from '../core'
import { errorResponse, successResponse } from '../responses/rpc-response'

const MAX_STAGED_BYTES = 2 * RUNTIME_RPC_MAX_STAGED_REPLY_BYTES
// A client reads parts back to back; an abandoned reply is dropped after this idle time.
const STAGED_REPLY_IDLE_MS = 60_000

type StagedReply = { deviceId: string; text: string; bytes: number; timer: NodeJS.Timeout }

/** Replies too large for one frame, held until the paired device that asked reads them in parts. */
export class RuntimeRpcStagedReplies {
  private readonly replies = new Map<string, StagedReply>()
  private stagedBytes = 0

  constructor(private readonly runtimeId: () => string) {}

  stage(deviceId: string, text: string, bytes: number): RuntimeRpcStagedReplyHandle | null {
    if (bytes > RUNTIME_RPC_MAX_STAGED_REPLY_BYTES || this.stagedBytes + bytes > MAX_STAGED_BYTES) {
      return null
    }
    const replyId = randomUUID()
    this.replies.set(replyId, { deviceId, text, bytes, timer: this.expiry(replyId) })
    this.stagedBytes += bytes
    return { replyId, length: text.length }
  }

  /** The part at `offset`, or null when this device has no such reply; the last part frees it. */
  read(deviceId: string, replyId: string, offset: number): string | null {
    const reply = this.replies.get(replyId)
    if (!reply || reply.deviceId !== deviceId || offset < 0 || offset >= reply.text.length) {
      return null
    }
    let end = Math.min(offset + RUNTIME_RPC_STAGED_REPLY_PART_CHARS, reply.text.length)
    // Keep a surrogate pair in one part so each part is well-formed text.
    if (end < reply.text.length && isHighSurrogate(reply.text.charCodeAt(end - 1))) {
      end -= 1
    }
    const part = reply.text.slice(offset, end)
    if (end === reply.text.length) {
      this.drop(replyId)
    } else {
      reply.timer.refresh()
    }
    return part
  }

  /** For a client that reads parts: keeps an oversize reply and answers `reply_staged` naming it. */
  stagerFor(
    clientCapabilities: readonly RuntimeCapability[] | undefined,
    requestId: string,
    deviceId: string,
    // A caller whose socket closed can't read parts, so its reply isn't kept.
    signal: AbortSignal | undefined
  ): ((response: string, bytes: number) => RpcResponse | null) | undefined {
    if (!clientCapabilities?.includes(RUNTIME_RPC_STAGED_REPLY_CLIENT_CAPABILITY)) {
      return undefined
    }
    return (response, bytes) => {
      const handle = signal?.aborted ? null : this.stage(deviceId, response, bytes)
      return handle
        ? errorResponse(
            requestId,
            this.meta(),
            RUNTIME_RPC_REPLY_STAGED_CODE,
            `The result is too large for one reply; read it with ${RUNTIME_RPC_READ_STAGED_REPLY_METHOD}.`,
            handle
          )
        : null
    }
  }

  /** Answers a part read; false when the request is some other method. */
  answerRead(request: RpcRequest, deviceId: string, reply: (response: string) => void): boolean {
    if (request.method !== RUNTIME_RPC_READ_STAGED_REPLY_METHOD) {
      return false
    }
    const params = RuntimeRpcReadStagedReplyParamsSchema.safeParse(request.params)
    const text = params.success
      ? this.read(deviceId, params.data.replyId, params.data.offset)
      : null
    const response =
      text === null
        ? errorResponse(
            request.id,
            this.meta(),
            'not_found',
            'That staged reply is gone. Run the command again.'
          )
        : successResponse(request.id, this.meta(), { text })
    reply(JSON.stringify(response))
    return true
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtimeId() }
  }

  private expiry(replyId: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.drop(replyId), STAGED_REPLY_IDLE_MS)
    timer.unref?.()
    return timer
  }

  private drop(replyId: string): void {
    const reply = this.replies.get(replyId)
    if (reply) {
      clearTimeout(reply.timer)
      this.replies.delete(replyId)
      this.stagedBytes -= reply.bytes
    }
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
