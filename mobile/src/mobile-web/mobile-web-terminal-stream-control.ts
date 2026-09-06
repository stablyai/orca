import type { RpcClient } from '../transport/rpc-client'
import { TerminalStreamOpcode } from '../transport/terminal-stream-protocol'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'
import { sendMobileWebTerminalFrame } from './mobile-web-terminal-host-transport'

export function setMobileWebTerminalVisibility(args: {
  client: RpcClient
  record: MobileWebTerminalStreamRecord
  visible: boolean
  subscribe: () => void
}): void {
  if (args.record.visible === args.visible) {
    return
  }
  args.record.visible = args.visible
  args.record.hostReady = false
  if (args.visible) {
    args.subscribe()
  } else {
    sendMobileWebTerminalFrame(args.client, args.record, TerminalStreamOpcode.Unsubscribe)
  }
}

export function sendMobileWebTerminalAckBytes(
  client: RpcClient,
  record: MobileWebTerminalStreamRecord,
  bytes: number
): void {
  if (bytes > 0) {
    sendMobileWebTerminalFrame(client, record, TerminalStreamOpcode.Ack, { bytes })
  }
}
