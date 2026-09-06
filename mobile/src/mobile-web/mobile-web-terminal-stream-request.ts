import type {
  MobileWebTerminalDeviceInputResult,
  MobileWebTerminalRequest
} from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { RpcClient } from '../transport/rpc-client'
import { TerminalStreamOpcode } from '../transport/terminal-stream-protocol'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'
import { handleMobileWebTerminalInput } from './mobile-web-terminal-input'
import { sendMobileWebTerminalFrame } from './mobile-web-terminal-host-transport'
import { setMobileWebTerminalVisibility } from './mobile-web-terminal-stream-control'
import type { MobileWebTerminalResyncReason } from './mobile-web-diagnostics-store'

export function handleMobileWebTerminalStreamRequest(args: {
  client: RpcClient
  record: MobileWebTerminalStreamRecord
  request: Exclude<MobileWebTerminalRequest, { operation: 'subscribe' }>
  isLive: () => boolean
  acknowledge: (throughSequence: number) => void
  sendSubscribe: () => void
  requestSnapshot: (reason: MobileWebTerminalResyncReason) => void
  cancel: () => void
}): null | Promise<null | MobileWebTerminalDeviceInputResult> {
  const { client, record, request } = args
  if (request.operation === 'ack') {
    args.acknowledge(request.throughSequence)
  } else if (
    request.operation === 'input' ||
    request.operation === 'queryReply' ||
    request.operation === 'clipboardPaste' ||
    request.operation === 'attachImage'
  ) {
    return handleMobileWebTerminalInput({
      client,
      record,
      request,
      isLive: args.isLive
    })
  } else if (request.operation === 'resize') {
    record.viewport = request.viewport
    sendMobileWebTerminalFrame(client, record, TerminalStreamOpcode.Resize, request.viewport)
  } else if (request.operation === 'visibility') {
    setMobileWebTerminalVisibility({
      client,
      record,
      visible: request.visible,
      subscribe: args.sendSubscribe
    })
  } else if (request.operation === 'resync') {
    args.requestSnapshot(request.reason)
  } else if (request.operation === 'cancel') {
    args.cancel()
  }
  return null
}
