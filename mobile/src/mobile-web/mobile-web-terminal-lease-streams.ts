import {
  MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES,
  type MobileWebTerminalEvent,
  type MobileWebTerminalRequest
} from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import {
  MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE,
  MOBILE_WEB_TERMINAL_DELIVERY_CLOSURE
} from './mobile-web-terminal-stream-retirement'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type LeaseSubscribeRequest = Extract<MobileWebTerminalRequest, { operation: 'subscribe' }>

type LeaseRecord = {
  requestId: string
  pageWorkspaceId: string
  hostWorkspaceId: string
  pageStreamId: string
  viewport: LeaseSubscribeRequest['viewport']
  sequence: number
  active: boolean
  unsubscribe: () => void
  delivery: Promise<void>
}

export class MobileWebTerminalLeaseStreams {
  private readonly records = new Map<string, LeaseRecord>()

  constructor(
    private readonly options: {
      isActive: () => boolean
      clientId: string
      workspaceAuthority: MobileWebWorkspaceAuthority
      postEvent: (
        subscriptionId: string,
        sequence: number,
        event: MobileWebTerminalEvent
      ) => Promise<void>
      postClosed: MobileWebPostSubscriptionClosed
    }
  ) {}

  start(args: {
    requestId: string
    subscriptionId: string
    request: LeaseSubscribeRequest
    hostWorkspaceId: string
    terminal: string
    client: RpcClient
  }): void {
    if (this.records.has(args.subscriptionId)) {
      throw new MobileWebBrokerError('invalid_request')
    }
    const record: LeaseRecord = {
      requestId: args.requestId,
      pageWorkspaceId: args.request.workspaceId,
      hostWorkspaceId: args.hostWorkspaceId,
      pageStreamId: args.subscriptionId,
      viewport: args.request.viewport,
      sequence: 0,
      active: true,
      unsubscribe: () => {},
      delivery: Promise.resolve()
    }
    this.records.set(args.subscriptionId, record)
    try {
      const unsubscribe = args.client.subscribe(
        'terminal.subscribe',
        {
          terminal: args.terminal,
          client: { id: this.options.clientId, type: 'mobile' },
          capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
        },
        (event) => this.receive(args.subscriptionId, record, event)
      )
      if (record.active && this.records.get(args.subscriptionId) === record) {
        record.unsubscribe = unsubscribe
      } else {
        unsubscribe()
      }
    } catch {
      this.retire(record)
      throw new MobileWebBrokerError('host_error')
    }
  }

  has(streamId: string): boolean {
    return this.records.has(streamId)
  }

  cancel(subscriptionId: string, closure?: MobileWebSubscriptionClosure): string | null {
    const record = this.records.get(subscriptionId)
    if (!record) {
      return null
    }
    this.retire(record, closure)
    return record.requestId
  }

  cancelByRequest(requestId: string): void {
    for (const [subscriptionId, record] of this.records) {
      if (record.requestId === requestId) {
        this.cancel(subscriptionId)
      }
    }
  }

  dispose(closure?: MobileWebSubscriptionClosure): void {
    for (const subscriptionId of this.records.keys()) {
      this.cancel(subscriptionId, closure)
    }
  }

  get size(): number {
    return this.records.size
  }

  private receive(subscriptionId: string, record: LeaseRecord, value: unknown): void {
    if (!this.isLive(subscriptionId, record)) {
      this.retire(record)
      return
    }
    if (!this.isAuthorized(record)) {
      this.retire(record, MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE)
      return
    }
    if (!isRecord(value) || typeof value.type !== 'string') {
      this.post(
        record,
        {
          type: 'error',
          streamId: record.pageStreamId,
          code: 'invalid_message',
          recoverable: false
        },
        true
      )
      return
    }
    if (value.type === 'subscribed') {
      this.post(record, {
        type: 'subscribed',
        streamId: record.pageStreamId,
        viewport: record.viewport,
        startSequence: 0,
        // Why: a lease stream negotiates no output multiplex, so it carries no reply opcode.
        maxOutstandingBytes: MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES,
        queryReplyNegotiated: false
      })
      return
    }
    if (value.type === 'end') {
      this.post(
        record,
        {
          type: 'closed',
          streamId: record.pageStreamId,
          reason: 'terminal-exited'
        },
        true
      )
      return
    }
    if (value.type === 'error') {
      this.post(
        record,
        {
          type: 'error',
          streamId: record.pageStreamId,
          code: 'unavailable',
          recoverable: true
        },
        true
      )
    }
  }

  private post(record: LeaseRecord, event: MobileWebTerminalEvent, retireAfter = false): void {
    const sequence = record.sequence++
    record.delivery = record.delivery
      .then(async () => {
        if (this.isLive(record.pageStreamId, record) && this.isAuthorized(record)) {
          await this.options.postEvent(record.pageStreamId, sequence, event)
        }
      })
      .then(() => {
        if (retireAfter) {
          this.retire(record)
        }
      })
      .catch(() => this.retire(record, MOBILE_WEB_TERMINAL_DELIVERY_CLOSURE))
  }

  private isLive(subscriptionId: string, record: LeaseRecord): boolean {
    return record.active && this.options.isActive() && this.records.get(subscriptionId) === record
  }

  private isAuthorized(record: LeaseRecord): boolean {
    try {
      return (
        this.options.workspaceAuthority.hostWorkspaceId(record.pageWorkspaceId) ===
        record.hostWorkspaceId
      )
    } catch {
      return false
    }
  }

  private retire(record: LeaseRecord, closure?: MobileWebSubscriptionClosure): void {
    if (!record.active) {
      return
    }
    record.active = false
    this.records.delete(record.pageStreamId)
    try {
      record.unsubscribe()
    } catch {
      // The authenticated host subscription is already gone.
    }
    if (closure) {
      this.options.postClosed(record.pageStreamId, closure)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
