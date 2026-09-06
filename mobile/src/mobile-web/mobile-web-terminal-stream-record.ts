import type { MobileWebTerminalRequest } from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'

export function createMobileWebTerminalStreamRecord(args: {
  requestId: string
  subscriptionId: string
  request: Extract<MobileWebTerminalRequest, { operation: 'subscribe' }>
  hostWorkspaceId: string
  hostStreamId: number
  terminal: string
  client: RpcClient
}): MobileWebTerminalStreamRecord {
  return {
    requestId: args.requestId,
    subscriptionId: args.subscriptionId,
    pageWorkspaceId: args.request.workspaceId,
    hostWorkspaceId: args.hostWorkspaceId,
    pageStreamId: args.subscriptionId,
    hostStreamId: args.hostStreamId,
    terminal: args.terminal,
    viewport: args.request.viewport,
    visible: args.request.visible,
    hostReady: false,
    supportsQueryReply: false,
    bridgeSequence: 0,
    sentSequence: 0,
    acknowledgedSequence: 0,
    nextInputSequence: 0,
    snapshotCounter: 0,
    snapshot: null,
    pendingOutput: [],
    pendingOutputBytes: 0,
    ackSpans: [],
    delivery: Promise.resolve(),
    inputDelivery: Promise.resolve(),
    client: args.client
  }
}
