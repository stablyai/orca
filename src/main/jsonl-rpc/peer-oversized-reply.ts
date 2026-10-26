import type { NdjsonRejectedRecord } from '../../shared/main-process-ndjson-framer'

/** A reply over the line cap, refused for the one request that asked to survive it. */
export class JsonlRpcReplyTooLargeError extends Error {
  constructor(
    readonly command: string,
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`Agent reply to ${command} exceeded ${maxBytes} bytes`)
    this.name = 'JsonlRpcReplyTooLargeError'
  }
}

export type JsonlRpcRequestOptions = {
  timeoutMs?: number | null
  /** An optional read whose oversized reply fails only itself instead of the stream. */
  oversizedReply?: 'reject'
}

// Pi echoes opaque ids before the response payload; the category survives its waiter's timeout.
const OVERSIZED_REPLY_HEAD = /^\{"id":"(orca-optional-([1-9]\d*))","type":"response"(?=[,}])/

/**
 * Only an issued optional reply can be dropped alone. Complete-queue loss may also omit
 * lifecycle records, even when its prefix identifies an optional reply.
 */
export function oversizedReplyRequest(
  rejected: Extract<NdjsonRejectedRecord, { kind: 'line-too-long' }>,
  highestOptionalAssigned: number
): string | null {
  const head = OVERSIZED_REPLY_HEAD.exec(rejected.prefix)
  if (!head || rejected.droppedCompleteRecords) {
    return null
  }
  const number = Number(head[2])
  return Number.isSafeInteger(number) && number <= highestOptionalAssigned ? head[1] : null
}
