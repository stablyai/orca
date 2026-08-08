import type { RoomDelivery, RoomEvent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import type { RoomHarnessTurnUserMessage } from './harness-lifecycle'
import { formatRoomDeliveryPrompt, roomDeliveryIdFromTurn } from './delivery-prompt'
import type { RoomAttachmentManager } from './attachments'
import {
  deliveryFailureState,
  selectConcurrentDeliveries,
  suppressPausedDelivery
} from './delivery-selection'
import { stageRoomDeliveryAttachments } from './delivery-attachments'
import type { PendingRoomDeliveryConfirmation } from './delivery-configuration'

const MAX_DELIVERY_ATTEMPTS = 5
const MAX_RETRY_DELAY_MS = 60_000
/** Bounds turn-open (seconds physics, wide margin) — never the answer time.
 *  Expiry only initiates the facts check in expireUnconfirmed, never a blind resend. */
const CONFIRM_TURN_DEADLINE_MS = 30_000

export class RoomDeliveryWorker {
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private rerun = false
  private disposed = false
  private readonly pendingConfirmations = new Map<string, PendingRoomDeliveryConfirmation>()
  private readonly confirmDeadlines = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<string, RoomHarnessAdapter>,
    private readonly attachments: RoomAttachmentManager,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly ensureParticipantReady: (participantId: string) => Promise<RoomParticipant>,
    private readonly confirmDeadlineMs = CONFIRM_TURN_DEADLINE_MS
  ) {}

  start(): void {
    this.db.messages.deliveries.recoverInterrupted()
    this.wake()
  }

  wake(): void {
    if (this.disposed) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.draining) {
      this.rerun = true
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, 0)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.confirmDeadlines.forEach((timer) => clearTimeout(timer))
    this.confirmDeadlines.clear()
    this.pendingConfirmations.clear()
  }

  /** Stable delivery IDs distinguish room turns from direct Chat/CLI turns. */
  confirmTurn(participantId: string, userMessage: RoomHarnessTurnUserMessage): RoomDelivery | null {
    const deliveryId = roomDeliveryIdFromTurn(userMessage.text)
    if (!deliveryId) {
      return this.db.messages.deliveries.awaitingResponseForTurn(participantId, userMessage.id)
    }
    let delivery: RoomDelivery
    try {
      delivery = this.db.messages.deliveries.get(deliveryId)
    } catch {
      return this.db.messages.deliveries.awaitingResponseForTurn(participantId, userMessage.id)
    }
    const pending = this.pendingConfirmations.get(delivery.id)
    const confirmable =
      delivery.participantId === participantId &&
      (delivery.state === 'delivering' ||
        (delivery.state === 'failed' && delivery.error === 'room_delivery_uncertain'))
    if (!confirmable || (pending && pending.participantId !== participantId)) {
      return this.db.messages.deliveries.awaitingResponseForTurn(participantId, userMessage.id)
    }
    const message = this.db.messages.get(delivery.messageId)
    const confirmed = this.db.transaction(() => {
      const result = this.db.messages.deliveries.confirmTurn(delivery.id, userMessage.id)
      if (pending) {
        this.db.deliveryConfiguration.commit(participantId, pending.configuration)
      } else {
        this.db.deliveryConfiguration.requireFull(participantId)
      }
      return result
    })
    this.pendingConfirmations.delete(delivery.id)
    this.clearConfirmDeadline(delivery.id)
    this.emit(message.roomId, { type: 'delivery.updated', delivery: confirmed })
    this.wake()
    return confirmed
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) {
      return
    }
    this.draining = true
    try {
      do {
        this.rerun = false
        const due = this.db.messages.deliveries.listDue()
        for (const candidate of selectConcurrentDeliveries(due)) {
          const delivery = this.db.messages.deliveries.claim(candidate.id)
          if (!delivery) {
            continue
          }
          // One slow harness must not block other participants' queues.
          void this.deliver(delivery).finally(() => this.wake())
        }
      } while (this.rerun || this.db.messages.deliveries.listDue().length > 0)
    } finally {
      this.draining = false
      this.scheduleNext()
    }
  }

  private async deliver(delivery: RoomDelivery): Promise<void> {
    const message = this.db.messages.get(delivery.messageId)
    let target = this.db.participants.get(delivery.participantId)
    this.emit(message.roomId, { type: 'delivery.updated', delivery })
    try {
      if (this.db.core.get(message.roomId).archivedAt) {
        throw new Error('room_archived')
      }
      const initiallySuppressed = suppressPausedDelivery(this.db, delivery, target)
      if (initiallySuppressed) {
        return this.emit(target.roomId, { type: 'delivery.updated', delivery: initiallySuppressed })
      }
      // A second status probe would reject silent daemon-recovered PTYs.
      target = await this.ensureParticipantReady(target.id)
      const adapter = target.agent ? this.adapters[target.agent] : undefined
      const binding = this.binding(target)
      if (!adapter || !binding) {
        throw new Error('room_agent_not_attached')
      }
      const snapshot = this.db.snapshot(message.roomId)
      const role = snapshot.roles.find((item) => item.id === target.roleId) ?? null
      const configuration = this.db.deliveryConfiguration.pending({
        participant: target,
        room: snapshot.room,
        role
      })
      const replyParent = message.replyToId ? this.db.messages.get(message.replyToId) : null
      const attachmentPaths = await stageRoomDeliveryAttachments({
        adapter,
        binding,
        attachments: this.attachments,
        messages: replyParent ? [replyParent, message] : [message]
      })
      const prompt = formatRoomDeliveryPrompt({
        deliveryId: delivery.id,
        response: message.mentions.some(
          (identity) => identity.toLocaleLowerCase() === target.identity.toLocaleLowerCase()
        )
          ? 'required'
          : 'optional',
        roomName: snapshot.room.name,
        message,
        replyParent,
        target,
        participants: snapshot.participants,
        configuration: configuration.configuration,
        attachmentPaths
      })
      const imagePaths = message.attachments
        .filter((attachment) => attachment.mimeType.startsWith('image/'))
        .map((attachment) => attachmentPaths.get(attachment.id)!)
      target = this.db.participants.get(delivery.participantId)
      const suppressed = suppressPausedDelivery(this.db, delivery, target)
      if (suppressed) {
        return this.emit(target.roomId, { type: 'delivery.updated', delivery: suppressed })
      }
      this.pendingConfirmations.set(delivery.id, {
        participantId: target.id,
        configuration: configuration.snapshot
      })
      delivery = this.db.messages.deliveries.setPhase(delivery.id, 'submitting')
      this.emit(message.roomId, { type: 'delivery.updated', delivery })
      const result = await adapter.send(binding, prompt, {
        clearInput: true,
        ...(imagePaths.length > 0 ? { imagePaths } : {})
      })
      if (!result.accepted) {
        throw new Error(result.refusedReason ?? 'room_delivery_refused')
      }
      if (this.db.messages.deliveries.get(delivery.id).state !== 'delivering') {
        return
      }
      delivery = this.db.messages.deliveries.setPhase(delivery.id, 'awaiting-turn')
      this.emit(message.roomId, { type: 'delivery.updated', delivery })
      // Only a provider turn confirms PTY paste; a swallowed paste must be requeued.
      this.armConfirmDeadline(delivery.id)
    } catch (error) {
      this.pendingConfirmations.delete(delivery.id)
      if (this.disposed) {
        return
      }
      const messageText = error instanceof Error ? error.message : String(error)
      const exhausted =
        messageText === 'room_archived' || delivery.attempts >= MAX_DELIVERY_ATTEMPTS
      const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.max(0, delivery.attempts - 1))
      const failed = this.db.messages.deliveries.complete(
        delivery.id,
        deliveryFailureState(exhausted),
        messageText,
        exhausted ? Number.MAX_SAFE_INTEGER : Date.now() + delay
      )
      this.emit(message.roomId, { type: 'delivery.updated', delivery: failed })
    }
  }

  private armConfirmDeadline(deliveryId: string): void {
    this.clearConfirmDeadline(deliveryId)
    if (this.disposed) {
      return
    }
    const timer = setTimeout(() => {
      this.confirmDeadlines.delete(deliveryId)
      void this.expireUnconfirmed(deliveryId)
    }, this.confirmDeadlineMs)
    timer.unref?.()
    this.confirmDeadlines.set(deliveryId, timer)
  }

  private clearConfirmDeadline(deliveryId: string): void {
    clearTimeout(this.confirmDeadlines.get(deliveryId))
    this.confirmDeadlines.delete(deliveryId)
  }

  /** A working agent may be running our turn with the watcher lagging — keep
   *  waiting; only an idle agent whose turn never opened proves a swallowed paste. */
  private async expireUnconfirmed(deliveryId: string): Promise<void> {
    if (this.disposed || !this.pendingConfirmations.has(deliveryId)) {
      return
    }
    let delivery: RoomDelivery
    try {
      delivery = this.db.messages.deliveries.get(deliveryId)
    } catch {
      this.pendingConfirmations.delete(deliveryId)
      return
    }
    if (delivery.state !== 'delivering') {
      this.pendingConfirmations.delete(deliveryId)
      return
    }
    const participant = this.participantOrNull(delivery.participantId)
    const adapter = participant?.agent ? this.adapters[participant.agent] : undefined
    const binding = participant ? this.binding(participant) : null
    const status = adapter && binding ? await adapter.status(binding).catch(() => null) : null
    if (status?.isRunningAgent && status.status === 'working') {
      this.armConfirmDeadline(deliveryId)
      return
    }
    // Re-check: the turn may have confirmed while the status probe was in flight.
    if (this.disposed || !this.pendingConfirmations.has(deliveryId)) {
      return
    }
    this.pendingConfirmations.delete(deliveryId)
    const message = this.db.messages.get(delivery.messageId)
    const provenIdle = status?.isRunningAgent && status.status === 'idle'
    const exhausted = !provenIdle || delivery.attempts >= MAX_DELIVERY_ATTEMPTS
    const requeued = this.db.messages.deliveries.complete(
      deliveryId,
      deliveryFailureState(exhausted),
      provenIdle ? 'room_delivery_unconfirmed' : 'room_delivery_uncertain',
      exhausted ? Number.MAX_SAFE_INTEGER : Date.now()
    )
    this.emit(message.roomId, { type: 'delivery.updated', delivery: requeued })
    this.wake()
  }

  private participantOrNull(id: string): RoomParticipant | null {
    try {
      return this.db.participants.get(id)
    } catch {
      return null
    }
  }

  private scheduleNext(): void {
    if (this.disposed || this.timer) {
      return
    }
    const nextDueAt = this.db.messages.deliveries.nextDueAt()
    if (nextDueAt === null) {
      return
    }
    const delay = Math.min(2_147_000_000, Math.max(0, nextDueAt - Date.now()))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, delay)
    this.timer.unref?.()
  }

  private binding(participant: RoomParticipant): RoomHarnessBinding | null {
    return participant.terminalHandle && participant.paneKey && participant.worktreeId
      ? {
          worktreeId: participant.worktreeId,
          terminalHandle: participant.terminalHandle,
          paneKey: participant.paneKey,
          providerSession: participant.providerSession
        }
      : null
  }
}
