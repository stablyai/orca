import { serialize } from 'node:v8'
import type { UtilityWorkerPortEvent } from './utility-worker-host-protocol'

export function serializedWorkerReplyBytes(reply: unknown) {
  const bytes = serialize(reply)
  const envelope: UtilityWorkerPortEvent = {
    type: 'message',
    bytes,
    more: false,
    seq: Number.MAX_SAFE_INTEGER
  }
  return { payload: bytes.byteLength, framed: serialize(envelope).byteLength }
}
