import type { NdjsonRejectedRecord } from '../../shared/main-process-ndjson-framer'

/** A reply over the line cap, refused for the one request that asked to survive it. */
class JsonlRpcReplyTooLargeError extends Error {
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
function oversizedReplyRequest(
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

// Pi leads every event with its type; replies and dialog requests have waiters and cannot be skipped.
const OVERSIZED_EVENT_HEAD = /^\{"type":"([a-z_]+)"(?=[,}])/

/** An event over the line cap is dropped alone; its type lets the dialect keep the turn going. */
function oversizedEventType(
  rejected: Extract<NdjsonRejectedRecord, { kind: 'line-too-long' }>
): string | null {
  const type = OVERSIZED_EVENT_HEAD.exec(rejected.prefix)?.[1]
  return !type ||
    rejected.droppedCompleteRecords ||
    type === 'response' ||
    type === 'extension_ui_request'
    ? null
    : type
}

type JsonlRpcOversizedRecordTarget = {
  highestOptionalAssigned: number
  maxLineBytes: number
  pendingCommand: (id: string) => string | undefined
  rejectPending: (id: string, error: Error) => void
  skipEvent: (type: string) => void
  close: (error: Error) => void
}

/** An event or an optional reply fails alone; anything else may be awaited, so the stream ends. */
export function settleOversizedJsonlRecord(
  rejected: Extract<NdjsonRejectedRecord, { kind: 'line-too-long' }>,
  target: JsonlRpcOversizedRecordTarget
): void {
  const id = oversizedReplyRequest(rejected, target.highestOptionalAssigned)
  if (id) {
    const command = target.pendingCommand(id)
    if (command) {
      const error = new JsonlRpcReplyTooLargeError(
        command,
        rejected.observedBytes,
        target.maxLineBytes
      )
      target.rejectPending(id, error)
    }
    return
  }
  const event = oversizedEventType(rejected)
  if (event) {
    target.skipEvent(event)
  } else {
    target.close(new Error('JSON-lines RPC record exceeded the size limit'))
  }
}
