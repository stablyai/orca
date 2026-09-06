import type { RpcClient } from '../transport/rpc-client'
import {
  encodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../transport/terminal-stream-protocol'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'

export function sendMobileWebTerminalSubscribe(
  client: RpcClient,
  record: MobileWebTerminalStreamRecord,
  clientId: string
): void {
  sendMobileWebTerminalFrame(
    client,
    record,
    TerminalStreamOpcode.Subscribe,
    {
      streamId: record.hostStreamId,
      terminal: record.terminal,
      client: { id: clientId, type: 'mobile' },
      viewport: record.viewport,
      capabilities: { ackOutput: 1, queryReply: 1 }
    },
    0
  )
}

export function sendMobileWebTerminalFrame(
  client: RpcClient,
  record: MobileWebTerminalStreamRecord,
  opcode: TerminalStreamOpcode,
  payload?: unknown,
  streamId = record.hostStreamId
): void {
  const bytes =
    payload instanceof Uint8Array
      ? payload
      : payload === undefined
        ? new Uint8Array()
        : encodeTerminalStreamJson(payload)
  if (!client.sendTerminalBinaryFrame({ opcode, streamId, seq: 0, payload: bytes })) {
    throw new MobileWebBrokerError('not_connected')
  }
}

export function safeUnsubscribeMobileWebTerminal(
  client: RpcClient,
  record: MobileWebTerminalStreamRecord
): void {
  try {
    sendMobileWebTerminalFrame(client, record, TerminalStreamOpcode.Unsubscribe)
  } catch {
    // The record still retires locally when the authenticated transport is already gone.
  }
}
