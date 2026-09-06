import {
  type MobileWebTerminalDeviceInputResult,
  MobileWebTerminalRequestSchema,
  type MobileWebTerminalEvent
} from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '../transport/terminal-stream-protocol'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import { runMobileWebTerminalAction } from './mobile-web-terminal-actions'
import {
  acknowledgeMobileWebTerminalOutput,
  handleMobileWebHostTerminalFrame,
  type MobileWebTerminalStreamRecord
} from './mobile-web-terminal-flow-control'
import {
  sendMobileWebTerminalFrame,
  sendMobileWebTerminalSubscribe
} from './mobile-web-terminal-host-transport'
import { handleMobileWebTerminalMultiplexEvent } from './mobile-web-terminal-multiplex-events'
import { resolveMobileWebTerminal } from './mobile-web-terminal-resolution'
import { MobileWebTerminalStreamRegistry } from './mobile-web-terminal-stream-registry'
import {
  MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE,
  MOBILE_WEB_TERMINAL_DELIVERY_CLOSURE,
  MobileWebTerminalStreamRetirement
} from './mobile-web-terminal-stream-retirement'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebTerminalLeaseStreams } from './mobile-web-terminal-lease-streams'
import { sendMobileWebTerminalAckBytes } from './mobile-web-terminal-stream-control'
import { createMobileWebTerminalStreamRecord } from './mobile-web-terminal-stream-record'
import { handleMobileWebTerminalStreamRequest } from './mobile-web-terminal-stream-request'
import type {
  MobileWebTerminalFlowMetrics,
  MobileWebTerminalResyncReason
} from './mobile-web-diagnostics-store'

export class MobileWebTerminalStreams {
  private readonly registry: MobileWebTerminalStreamRegistry
  private readonly retirement: MobileWebTerminalStreamRetirement
  private readonly leaseStreams: MobileWebTerminalLeaseStreams
  private disposeMultiplex: (() => void) | null = null
  private multiplexReady = false
  private nextSnapshotRequestId = 0

  constructor(
    private readonly options: {
      isActive: () => boolean
      clientId: string
      now?: () => number
      onFlowMetrics?: (metrics: MobileWebTerminalFlowMetrics) => void
      onResync?: (reason: MobileWebTerminalResyncReason) => void
      workspaceAuthority: MobileWebWorkspaceAuthority
      postEvent: (
        subscriptionId: string,
        sequence: number,
        event: MobileWebTerminalEvent
      ) => Promise<void>
      postClosed: MobileWebPostSubscriptionClosed
    }
  ) {
    this.registry = new MobileWebTerminalStreamRegistry(options.workspaceAuthority)
    this.retirement = new MobileWebTerminalStreamRetirement({
      registry: this.registry,
      postClosed: options.postClosed
    })
    this.leaseStreams = new MobileWebTerminalLeaseStreams(options)
  }

  async start(args: {
    requestId: string
    subscriptionId: string
    payload: unknown
    client: RpcClient
    isRequestActive: () => boolean
  }): Promise<void> {
    const request = MobileWebTerminalRequestSchema.parse(args.payload)
    if (request.operation !== 'subscribe') {
      throw new MobileWebBrokerError('invalid_request')
    }
    if (
      this.registry.hasPageStream(args.subscriptionId) ||
      this.leaseStreams.has(args.subscriptionId)
    ) {
      throw new MobileWebBrokerError('invalid_request')
    }
    const hostWorkspaceId = this.options.workspaceAuthority.hostWorkspaceId(request.workspaceId)
    const terminal = await resolveMobileWebTerminal(args.client, hostWorkspaceId, request.tabId)
    if (!args.isRequestActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    if (request.leaseOnly) {
      if (request.visible) {
        throw new MobileWebBrokerError('invalid_request')
      }
      this.leaseStreams.start({
        requestId: args.requestId,
        subscriptionId: args.subscriptionId,
        request,
        hostWorkspaceId,
        terminal,
        client: args.client
      })
      return
    }
    const record = createMobileWebTerminalStreamRecord({
      requestId: args.requestId,
      subscriptionId: args.subscriptionId,
      hostWorkspaceId,
      hostStreamId: this.registry.allocateHostStreamId(),
      terminal,
      request,
      client: args.client
    })
    this.registry.register(record)
    this.ensureMultiplex(args.client)
    if (this.multiplexReady && record.visible) {
      this.sendSubscribe(args.client, record)
    }
  }

  handle(
    payload: unknown,
    client: RpcClient
  ): null | Promise<null | MobileWebTerminalDeviceInputResult> {
    const request = MobileWebTerminalRequestSchema.parse(payload)
    if (request.operation === 'subscribe') {
      throw new MobileWebBrokerError('invalid_request')
    }
    const record = this.registry.pageRecord(request.streamId)
    if (!record) {
      throw new MobileWebBrokerError('not_found')
    }
    if (!this.isAuthorized(record)) {
      this.retirement.retire(record, client, MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE)
      throw new MobileWebBrokerError('not_found')
    }
    if (
      request.operation === 'displayMode' ||
      request.operation === 'clear' ||
      request.operation === 'rename'
    ) {
      return runMobileWebTerminalAction({
        client,
        clientId: this.options.clientId,
        record,
        request
      }).then(() => null)
    }
    return handleMobileWebTerminalStreamRequest({
      client,
      record,
      request,
      isLive: () =>
        this.options.isActive() &&
        record.hostReady &&
        this.registry.pageRecord(record.pageStreamId) === record &&
        this.isAuthorized(record),
      acknowledge: (throughSequence) => this.acknowledge(client, record, throughSequence),
      sendSubscribe: () => this.sendSubscribe(client, record),
      requestSnapshot: (reason) => this.requestSnapshot(client, record, reason),
      cancel: () => this.cancel(record.subscriptionId, client)
    })
  }

  cancel(subscriptionId: string, client: RpcClient | null): string | null {
    const leaseRequestId = this.leaseStreams.cancel(subscriptionId)
    if (leaseRequestId) {
      return leaseRequestId
    }
    const record = this.registry.pageRecord(subscriptionId)
    if (!record) {
      return null
    }
    this.retirement.retire(record, client)
    return record.requestId
  }

  cancelByRequest(requestId: string, client: RpcClient | null): void {
    this.leaseStreams.cancelByRequest(requestId)
    for (const record of this.registry.records()) {
      if (record.requestId === requestId) {
        this.cancel(record.subscriptionId, client)
      }
    }
  }

  countForOperation(operationKey: string): number {
    return operationKey === 'terminal.subscribe' ? this.registry.size + this.leaseStreams.size : 0
  }

  dispose(client: RpcClient | null, closure?: MobileWebSubscriptionClosure): void {
    this.leaseStreams.dispose(closure)
    for (const record of this.registry.records()) {
      this.retirement.retire(record, client, closure)
    }
    this.registry.clear()
    this.disposeMultiplex?.()
    this.disposeMultiplex = null
    this.multiplexReady = false
  }

  private ensureMultiplex(client: RpcClient): void {
    if (this.disposeMultiplex) {
      return
    }
    this.disposeMultiplex = client.subscribe(
      'terminal.multiplex',
      {},
      (result) => this.handleMultiplexEvent(client, result),
      { onTerminalBinaryFrame: (frame) => this.handleHostFrame(client, frame) }
    )
  }

  private handleMultiplexEvent(client: RpcClient, result: unknown): void {
    this.retireUnauthorizedRecords(client)
    this.multiplexReady =
      handleMobileWebTerminalMultiplexEvent({
        result,
        records: this.registry.records(),
        recordForHostId: (streamId) => this.registry.hostRecord(streamId),
        sendSubscribe: (record) => this.sendSubscribe(client, record),
        post: (record, event) => this.post(record, event),
        retire: (record) => this.registry.retire(record)
      }) || this.multiplexReady
  }

  private handleHostFrame(client: RpcClient, frame: TerminalStreamFrame): boolean {
    const record = this.registry.hostRecord(frame.streamId)
    if (!record) {
      return false
    }
    if (!this.isAuthorized(record)) {
      this.retirement.retire(record, client, MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE)
      return true
    }
    handleMobileWebHostTerminalFrame(record, frame, this.flowContext(client))
    return true
  }

  private acknowledge(
    client: RpcClient,
    record: MobileWebTerminalStreamRecord,
    throughSequence: number
  ): void {
    if (!acknowledgeMobileWebTerminalOutput(record, throughSequence, this.flowContext(client))) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  private requestSnapshot(
    client: RpcClient,
    record: MobileWebTerminalStreamRecord,
    reason: MobileWebTerminalResyncReason
  ): void {
    this.options.onResync?.(reason)
    record.snapshot = null
    sendMobileWebTerminalFrame(client, record, TerminalStreamOpcode.SnapshotRequest, {
      requestId: ++this.nextSnapshotRequestId,
      scrollbackRows: 0
    })
  }

  private sendSubscribe(client: RpcClient, record: MobileWebTerminalStreamRecord): void {
    sendMobileWebTerminalSubscribe(client, record, this.options.clientId)
  }

  private post(record: MobileWebTerminalStreamRecord, event: MobileWebTerminalEvent): void {
    if (!this.options.isActive()) {
      // No closure: the shell drops every frame for an inactive page, so the host stream is all
      // there is left to release.
      this.retirement.retire(record, record.client)
      return
    }
    if (!this.isAuthorized(record)) {
      this.retirement.retire(record, record.client, MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE)
      return
    }
    const sequence = record.bridgeSequence++
    record.delivery = record.delivery
      .then(() => this.options.postEvent(record.subscriptionId, sequence, event))
      .catch(() => {
        this.retirement.retire(record, record.client, MOBILE_WEB_TERMINAL_DELIVERY_CLOSURE)
      })
  }

  private retireUnauthorizedRecords(client: RpcClient): void {
    for (const record of this.registry.retireUnauthorized()) {
      this.retirement.retire(record, client, MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE)
    }
  }

  private isAuthorized(record: MobileWebTerminalStreamRecord): boolean {
    return this.registry.isAuthorized(record)
  }

  private flowContext(client: RpcClient) {
    return {
      post: (record: MobileWebTerminalStreamRecord, event: MobileWebTerminalEvent) =>
        this.post(record, event),
      sendAckBytes: (record: MobileWebTerminalStreamRecord, bytes: number) =>
        sendMobileWebTerminalAckBytes(client, record, bytes),
      now: this.options.now ?? Date.now,
      recordFlow: (metrics: MobileWebTerminalFlowMetrics) => this.options.onFlowMetrics?.(metrics),
      requestSnapshot: (
        record: MobileWebTerminalStreamRecord,
        reason: MobileWebTerminalResyncReason
      ) => this.requestSnapshot(client, record, reason)
    }
  }
}
