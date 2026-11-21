import type { WebSocket } from 'ws'
import type { WsOutboundBackpressureQueue } from '../../../../../shared/network/websocket/ws-outbound-backpressure-queue'
import {
  createLegacyMobileE2EEReplyQueue,
  isMobileE2EEOutboundItemWithinLimit,
  type MobileE2EEOutboundBudgetClose,
  type MobileE2EEOutboundCap
} from './mobile-e2ee-outbound-admission'
import { encryptBytes } from '../../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import {
  createDesktopMobileE2EEV2OutboundQueue,
  desktopMobileE2EEV2OutboundItemBytes,
  type DesktopMobileE2EEV2OutboundItem
} from './mobile-e2ee-v2-desktop-outbound'
import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import {
  createMobileE2EEOutboundMemoryBudget,
  type MobileE2EEOutboundMemoryBudget,
  type MobileE2EEOutboundSocketMemory
} from './mobile-e2ee-outbound-memory-budget'
import type { RpcBinarySendOptions } from '../../transports/rpc-binary-sender'
import type { RuntimeClientCapabilities } from '../../callers/runtime-client-capabilities'
import { compressMobileE2EEV2Item } from './mobile-e2ee-v2-compressed-frame'

export class MobileE2EEDesktopOutboundOwner {
  private readonly memoryBudget: MobileE2EEOutboundMemoryBudget
  private readonly socketMemory: MobileE2EEOutboundSocketMemory | null
  // Why: one queue for text and binary, so a binary frame can neither overtake parked text nor drop silently.
  private legacyQueue: WsOutboundBackpressureQueue<string | Buffer> | null = null
  private v2Queue: WsOutboundBackpressureQueue<DesktopMobileE2EEV2OutboundItem> | null = null
  // Bytes each phone request's replies queued since the backlog was last empty; names an overflow's cause.
  private readonly backlogBytes = new Map<string, number>()

  constructor(
    private readonly ws: WebSocket,
    private readonly isLegacyKeyed: () => boolean,
    private readonly onClose: (close: MobileE2EEOutboundBudgetClose) => void,
    private readonly clientCapabilities: RuntimeClientCapabilities,
    memoryBudget: MobileE2EEOutboundMemoryBudget = createMobileE2EEOutboundMemoryBudget()
  ) {
    this.memoryBudget = memoryBudget
    this.socketMemory = memoryBudget.registerBufferedAmount(() => ws.bufferedAmount)
  }

  sendLegacyFrame(frame: string): boolean {
    if (this.socketMemory?.canSend(frame.length) !== true || this.ws.readyState !== this.ws.OPEN) {
      this.overflow(this.socketMemory ? 'bufferedBytes' : 'socketSources', 'control')
      return false
    }
    this.ws.send(frame)
    return true
  }

  enqueueLegacyText(frame: string, method: string): boolean {
    const queue = this.legacy()
    return queue ? this.enqueue(queue, frame, frame.length, method) : false
  }

  enqueueLegacyBinary(
    bytes: Uint8Array<ArrayBufferLike>,
    sharedKey: Uint8Array,
    method: string,
    options?: RpcBinarySendOptions
  ): boolean | 'backlogged' {
    const queue = this.legacy()
    if (!queue) {
      return false
    }
    // Why: idleness is judged on the sealed size (+40) before sealing, so a skipped frame costs no encryption.
    if (options?.dropWhenBacklogged && !queue.isIdle(bytes.byteLength + 40)) {
      return 'backlogged'
    }
    const sealed = Buffer.from(encryptBytes(bytes, sharedKey))
    return this.enqueue(queue, sealed, sealed.byteLength, method)
  }

  enqueueV2(
    plain: DesktopMobileE2EEV2OutboundItem,
    session: DesktopMobileE2EEV2Session,
    method: string,
    options?: RpcBinarySendOptions
  ): boolean | 'backlogged' {
    if (!isMobileE2EEOutboundItemWithinLimit(plain)) {
      this.onClose({ emitter: 'size', cap: 'maxFrameBytes', top_method: method })
      return false
    }
    const item = compressMobileE2EEV2Item(plain, this.clientCapabilities.current, options)
    if (!this.socketMemory) {
      this.overflow('socketSources')
      return false
    }
    this.v2Queue ??= createDesktopMobileE2EEV2OutboundQueue({
      ws: this.ws,
      session,
      memoryBudget: this.memoryBudget,
      socketMemory: this.socketMemory,
      onOverflow: (evidence) => this.overflow(evidence.cap)
    })
    const bytes = desktopMobileE2EEV2OutboundItemBytes(item)
    if (options?.dropWhenBacklogged && !this.v2Queue.isIdle(bytes)) {
      return 'backlogged'
    }
    return this.enqueue(this.v2Queue, item, bytes, method)
  }

  private enqueue<T>(
    queue: WsOutboundBackpressureQueue<T>,
    frame: T,
    bytes: number,
    method: string
  ): boolean {
    if (queue.queuedBytes() === 0) {
      this.backlogBytes.clear()
    }
    this.backlogBytes.set(method, (this.backlogBytes.get(method) ?? 0) + bytes)
    return queue.enqueue(frame)
  }

  /** `method` names a frame that never reached the queue; otherwise the backlog's largest. */
  private overflow(cap: MobileE2EEOutboundCap, method?: string): void {
    let top: [string, number] | undefined
    for (const entry of this.backlogBytes) {
      if (!top || entry[1] > top[1]) {
        top = entry
      }
    }
    const topMethod = method ?? top?.[0]
    this.onClose({ emitter: 'queue', cap, ...(topMethod ? { top_method: topMethod } : {}) })
  }

  private legacy(): WsOutboundBackpressureQueue<string | Buffer> | null {
    if (!this.socketMemory) {
      this.overflow('socketSources')
      return null
    }
    this.legacyQueue ??= createLegacyMobileE2EEReplyQueue({
      ws: this.ws,
      isKeyed: this.isLegacyKeyed,
      memoryBudget: this.memoryBudget,
      socketMemory: this.socketMemory,
      onOverflow: (evidence) => this.overflow(evidence.cap)
    })
    return this.legacyQueue
  }

  dispose(): void {
    this.legacyQueue?.dispose()
    this.legacyQueue = null
    this.v2Queue?.dispose()
    this.v2Queue = null
    this.socketMemory?.release()
  }
}
