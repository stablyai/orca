import type { WebSocket } from 'ws'
import type { WsOutboundBackpressureQueue } from '../../../shared/ws-outbound-backpressure-queue'
import { createLegacyMobileE2EETextReplyQueue } from './mobile-e2ee-outbound-admission'
import {
  createDesktopMobileE2EEV2OutboundQueue,
  type DesktopMobileE2EEV2OutboundItem
} from './mobile-e2ee-v2-desktop-outbound'
import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import {
  createMobileE2EEOutboundMemoryBudget,
  type MobileE2EEOutboundMemoryBudget,
  type MobileE2EEOutboundSocketMemory
} from './mobile-e2ee-outbound-memory-budget'

export class MobileE2EEDesktopOutboundOwner {
  private readonly memoryBudget: MobileE2EEOutboundMemoryBudget
  private readonly socketMemory: MobileE2EEOutboundSocketMemory | null
  private legacyQueue: WsOutboundBackpressureQueue<string> | null = null
  private v2Queue: WsOutboundBackpressureQueue<DesktopMobileE2EEV2OutboundItem> | null = null

  constructor(
    private readonly ws: WebSocket,
    memoryBudget: MobileE2EEOutboundMemoryBudget = createMobileE2EEOutboundMemoryBudget()
  ) {
    this.memoryBudget = memoryBudget
    this.socketMemory = memoryBudget.registerBufferedAmount(() => ws.bufferedAmount)
  }

  canSend(bytes: number): boolean {
    return this.socketMemory?.canSend(bytes) === true
  }

  sendLegacyFrame(frame: string, onOverflow: () => void): boolean {
    if (!this.canSend(frame.length) || this.ws.readyState !== this.ws.OPEN) {
      onOverflow()
      return false
    }
    this.ws.send(frame)
    return true
  }

  enqueueLegacyText(frame: string, isKeyed: () => boolean, onOverflow: () => void): boolean {
    if (!this.socketMemory) {
      onOverflow()
      return false
    }
    this.legacyQueue ??= createLegacyMobileE2EETextReplyQueue({
      ws: this.ws,
      isKeyed,
      memoryBudget: this.memoryBudget,
      socketMemory: this.socketMemory,
      onOverflow
    })
    return this.legacyQueue.enqueue(frame)
  }

  enqueueV2(
    item: DesktopMobileE2EEV2OutboundItem,
    session: DesktopMobileE2EEV2Session,
    onOverflow: () => void
  ): boolean {
    if (!this.socketMemory) {
      onOverflow()
      return false
    }
    this.v2Queue ??= createDesktopMobileE2EEV2OutboundQueue({
      ws: this.ws,
      session,
      memoryBudget: this.memoryBudget,
      socketMemory: this.socketMemory,
      onOverflow
    })
    return this.v2Queue.enqueue(item)
  }

  dispose(): void {
    this.legacyQueue?.dispose()
    this.legacyQueue = null
    this.v2Queue?.dispose()
    this.v2Queue = null
    this.socketMemory?.release()
  }
}
