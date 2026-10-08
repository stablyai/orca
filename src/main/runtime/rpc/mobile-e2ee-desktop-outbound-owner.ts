import type { WebSocket } from 'ws'
import type { WsOutboundBackpressureQueue } from '../../../shared/ws-outbound-backpressure-queue'
import { createLegacyMobileE2EEReplyQueue } from './mobile-e2ee-outbound-admission'
import { encryptBytes } from './e2ee-crypto'
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
import type { RpcBinarySendOptions } from './rpc-binary-sender'

export class MobileE2EEDesktopOutboundOwner {
  private readonly memoryBudget: MobileE2EEOutboundMemoryBudget
  private readonly socketMemory: MobileE2EEOutboundSocketMemory | null
  // Why: one queue for text and binary, so a binary frame can neither overtake parked text nor drop silently.
  private legacyQueue: WsOutboundBackpressureQueue<string | Buffer> | null = null
  private v2Queue: WsOutboundBackpressureQueue<DesktopMobileE2EEV2OutboundItem> | null = null

  constructor(
    private readonly ws: WebSocket,
    private readonly isLegacyKeyed: () => boolean,
    private readonly onOverflow: () => void,
    memoryBudget: MobileE2EEOutboundMemoryBudget = createMobileE2EEOutboundMemoryBudget()
  ) {
    this.memoryBudget = memoryBudget
    this.socketMemory = memoryBudget.registerBufferedAmount(() => ws.bufferedAmount)
  }

  sendLegacyFrame(frame: string): boolean {
    if (this.socketMemory?.canSend(frame.length) !== true || this.ws.readyState !== this.ws.OPEN) {
      this.onOverflow()
      return false
    }
    this.ws.send(frame)
    return true
  }

  enqueueLegacyText(frame: string): boolean {
    return this.legacy()?.enqueue(frame) ?? false
  }

  enqueueLegacyBinary(
    bytes: Uint8Array<ArrayBufferLike>,
    sharedKey: Uint8Array,
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
    return queue.enqueue(Buffer.from(encryptBytes(bytes, sharedKey)))
  }

  enqueueV2(
    item: DesktopMobileE2EEV2OutboundItem,
    session: DesktopMobileE2EEV2Session,
    options?: RpcBinarySendOptions
  ): boolean | 'backlogged' {
    if (!this.socketMemory) {
      this.onOverflow()
      return false
    }
    this.v2Queue ??= createDesktopMobileE2EEV2OutboundQueue({
      ws: this.ws,
      session,
      memoryBudget: this.memoryBudget,
      socketMemory: this.socketMemory,
      onOverflow: this.onOverflow
    })
    if (
      options?.dropWhenBacklogged &&
      !this.v2Queue.isIdle(desktopMobileE2EEV2OutboundItemBytes(item))
    ) {
      return 'backlogged'
    }
    return this.v2Queue.enqueue(item)
  }

  private legacy(): WsOutboundBackpressureQueue<string | Buffer> | null {
    if (!this.socketMemory) {
      this.onOverflow()
      return null
    }
    this.legacyQueue ??= createLegacyMobileE2EEReplyQueue({
      ws: this.ws,
      isKeyed: this.isLegacyKeyed,
      memoryBudget: this.memoryBudget,
      socketMemory: this.socketMemory,
      onOverflow: this.onOverflow
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
