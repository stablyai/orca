import {
  MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES,
  type MobileWebTerminalEvent
} from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'

export function handleMobileWebTerminalMultiplexEvent(args: {
  result: unknown
  records: Iterable<MobileWebTerminalStreamRecord>
  recordForHostId: (hostStreamId: number) => MobileWebTerminalStreamRecord | undefined
  sendSubscribe: (record: MobileWebTerminalStreamRecord) => void
  post: (record: MobileWebTerminalStreamRecord, event: MobileWebTerminalEvent) => void
  retire: (record: MobileWebTerminalStreamRecord) => void
}): boolean {
  if (!isRecord(args.result)) {
    return false
  }
  if (args.result.type === 'ready') {
    for (const record of args.records) {
      record.hostReady = false
      record.supportsQueryReply = false
      record.snapshot = null
      if (record.visible) {
        args.sendSubscribe(record)
      }
    }
    return true
  }
  if (args.result.type === 'subscribed' && typeof args.result.streamId === 'number') {
    const record = args.recordForHostId(args.result.streamId)
    if (record) {
      record.hostReady = true
      record.supportsQueryReply = hasQueryReplyCapability(args.result.capabilities)
      args.post(record, {
        type: 'subscribed',
        streamId: record.pageStreamId,
        viewport: record.viewport,
        startSequence: record.sentSequence,
        maxOutstandingBytes: MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES,
        queryReplyNegotiated: record.supportsQueryReply
      })
    }
    return false
  }
  if (args.result.type === 'end' && typeof args.result.streamId === 'number') {
    const record = args.recordForHostId(args.result.streamId)
    if (record) {
      args.post(record, {
        type: 'closed',
        streamId: record.pageStreamId,
        reason: 'terminal-exited'
      })
      args.retire(record)
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasQueryReplyCapability(value: unknown): boolean {
  return isRecord(value) && value.queryReply === 1
}
