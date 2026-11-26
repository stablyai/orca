import {
  MAX_PROVIDER_RECEIPT_REPLY_BYTES,
  type ProviderReceiptCursor,
  type ProviderReceiptReader,
  type ProviderReceiptReply,
  type ProviderReceiptStatus,
  type ProviderReceiptStreamUpdate
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { StructuredAgentSessionProviderReceipts } from '../../host/structured-agent-session-provider-receipts'
import type { ProviderReceiptStream } from './provider-receipt-stream'

export const MAX_PROVIDER_RECEIPT_DESTINATIONS = 256
const MAX_PROVIDER_RECEIPT_UNREAD_BYTES = 8 * 1024 * 1024
// Reserve one small terminal reply per destination so a full data budget cannot strand cleanup.
const TERMINAL_REPLY_BYTES = 512
const DATA_BUDGET =
  MAX_PROVIDER_RECEIPT_UNREAD_BYTES - MAX_PROVIDER_RECEIPT_DESTINATIONS * TERMINAL_REPLY_BYTES

export type ProviderReceiptDestination = {
  transport: AbortSignal
  document: AbortSignal
}

export type Membership = {
  stream: ProviderReceiptStream
  epoch?: string
  token: symbol
  staged?: ProviderReceiptStreamUpdate
  close: () => void
}
export type Reader = {
  source: StructuredAgentSessionProviderReceipts
  document: AbortSignal
  identity: ProviderReceiptReader
  streams: Map<string, Membership>
  ready: Set<Membership>
}
export type Wait = {
  document: AbortSignal
  reader?: Reader
  source?: StructuredAgentSessionProviderReceipts
  failure?: Exclude<ProviderReceiptStatus, 'changed'>
  resolve: (reply: ProviderReceiptReply) => void
  reject: (error: Error) => void
  cancelled: () => void
}
type Unread = {
  revision: ProviderReceiptCursor
  document: AbortSignal
  bytes: number
  stream?: { subscription: string; token: symbol }
  handedOff: boolean
}
export type Destination = {
  key: AbortSignal
  reader?: Reader
  waiting?: Wait
  unread?: Unread
  consumed?: ProviderReceiptCursor
  scheduled?: true
  retire: () => void
}

export function sameCursor(
  left: ProviderReceiptCursor,
  right: ProviderReceiptCursor | null
): boolean {
  return left.sequence === right?.sequence && left.nonce === right.nonce
}

export class ProviderReceiptCredits {
  private readonly destinations = new Map<AbortSignal, Destination>()
  private readonly blocked = new Set<Destination>()
  private unreadBytes = 0
  private waking = false

  constructor(private readonly wake: (target: Destination) => void) {}

  get(transport: AbortSignal): Destination | undefined {
    return this.destinations.get(transport)
  }

  isBlocked(target: Destination): boolean {
    return this.blocked.has(target)
  }

  parkIfFull(target: Destination): boolean {
    if (this.unreadBytes + MAX_PROVIDER_RECEIPT_REPLY_BYTES <= DATA_BUDGET) {
      return false
    }
    this.blocked.add(target)
    return true
  }

  discard(endpoint: ProviderReceiptDestination, revision: ProviderReceiptCursor): void {
    const target = this.destinations.get(endpoint.transport)
    if (target && this.release(target, endpoint.document, revision, true)) {
      this.prune(target)
    }
  }

  // Navigation cancels the waiter. Only a suppressed send or destruction frees unread bytes.
  handoff(endpoint: ProviderReceiptDestination): void {
    const unread = this.get(endpoint.transport)?.unread
    if (unread?.document === endpoint.document) {
      unread.handedOff = true
    }
  }

  suppress(endpoint: ProviderReceiptDestination): void {
    const unread = this.get(endpoint.transport)?.unread
    if (unread?.document === endpoint.document && !unread.handedOff) {
      this.discard(endpoint, unread.revision)
    }
  }

  allocate(transport: AbortSignal): Destination | undefined {
    if (this.destinations.size >= MAX_PROVIDER_RECEIPT_DESTINATIONS) {
      return undefined
    }
    const target: Destination = {
      key: transport,
      retire: () => {
        const wait = this.stopWait(target)
        wait?.reject(new Error('provider_receipt_sender_retired'))
        for (const member of target.reader?.streams.values() ?? []) {
          member.close()
        }
        this.remove(target)
      }
    }
    this.destinations.set(transport, target)
    transport.addEventListener('abort', target.retire, { once: true })
    return target
  }

  private remove(target: Destination): void {
    if (this.destinations.get(target.key) !== target) {
      return
    }
    this.destinations.delete(target.key)
    target.key.removeEventListener('abort', target.retire)
    if (target.unread) {
      this.unreadBytes -= target.unread.bytes
      target.unread = undefined
      this.wakeCapacity()
    }
  }

  prune(target: Destination): void {
    if (!target.reader && !target.waiting && !target.unread) {
      this.remove(target)
    }
  }

  release(
    target: Destination,
    document: AbortSignal,
    revision: ProviderReceiptCursor | null,
    discarded: boolean
  ): boolean {
    const unread = target.unread
    if (!unread || unread.document !== document || !sameCursor(unread.revision, revision)) {
      return false
    }
    target.unread = undefined
    target.consumed = unread.revision
    this.unreadBytes -= unread.bytes
    const member = unread.stream && target.reader?.streams.get(unread.stream.subscription)
    if (member && member.token === unread.stream?.token && member.staged) {
      const frame = member.staged
      member.staged = undefined
      if (discarded) {
        member.stream.discard()
      }
      if (discarded || member.stream.consume(frame)) {
        target.reader?.ready.add(member)
      }
    }
    this.wakeCapacity()
    return true
  }

  stopWait(target: Destination): Wait | undefined {
    const wait = target.waiting
    target.waiting = undefined
    wait?.cancelled()
    this.blocked.delete(target)
    return wait
  }

  deliver(
    target: Destination,
    wait: Wait,
    reply: ProviderReceiptReply,
    bytes: number,
    stream?: Unread['stream']
  ): void {
    if (
      bytes > MAX_PROVIDER_RECEIPT_REPLY_BYTES ||
      this.unreadBytes + bytes > MAX_PROVIDER_RECEIPT_UNREAD_BYTES
    ) {
      this.stopWait(target)
      this.prune(target)
      wait.reject(new Error('provider_receipt_capacity'))
      return
    }
    this.stopWait(target)
    target.unread = {
      revision: reply.revision,
      document: wait.document,
      bytes,
      stream,
      handedOff: false
    }
    this.unreadBytes += bytes
    wait.resolve(reply)
  }

  private wakeCapacity(): void {
    if (this.waking) {
      return
    }
    this.waking = true
    try {
      while (this.unreadBytes + MAX_PROVIDER_RECEIPT_REPLY_BYTES <= DATA_BUDGET) {
        const next = this.blocked.values().next().value
        if (!next) {
          break
        }
        this.blocked.delete(next)
        this.wake(next)
      }
    } finally {
      this.waking = false
    }
  }
}
