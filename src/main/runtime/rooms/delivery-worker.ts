import type { RoomDelivery, RoomEvent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import type { RoomHarnessTurnUserMessage } from './harness-lifecycle'
import { formatRoomDeliveryPrompt } from './delivery-prompt'
import type { RoomAttachmentManager } from './attachments'
import { deliveryFailureState, suppressPausedDelivery } from './delivery-selection'
import { stageRoomDeliveryAttachments } from './delivery-attachments'
import { RoomDeliveryConfirmations } from './delivery-confirmations'

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
  private readonly confirmations: RoomDeliveryConfirmations
  private readonly blockedRooms = new Map<string, number>()
  private readonly inFlight = new Map<string, Set<Promise<void>>>()

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<string, RoomHarnessAdapter>,
    private readonly attachments: RoomAttachmentManager,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly ensureParticipantReady: (participantId: string) => Promise<RoomParticipant>,
    confirmDeadlineMs = CONFIRM_TURN_DEADLINE_MS
  ) {
    this.confirmations = new RoomDeliveryConfirmations(
      db,
      adapters,
      emit,
      () => this.wake(),
      confirmDeadlineMs
    )
  }

  start(): void {
    this.db.messages.deliveries.suppressDeletedMessages()
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
    this.confirmations.dispose()
    this.blockedRooms.clear()
    this.inFlight.clear()
  }

  async blockRoom(roomId: string): Promise<void> {
    this.blockedRooms.set(roomId, (this.blockedRooms.get(roomId) ?? 0) + 1)
    const tasks = this.inFlight.get(roomId)
    if (tasks) {
      await Promise.allSettled(tasks)
    }
    this.confirmations.clearRoom(roomId)
  }

  unblockRoom(roomId: string): void {
    const remaining = (this.blockedRooms.get(roomId) ?? 1) - 1
    if (remaining === 0) {
      this.blockedRooms.delete(roomId)
    } else {
      this.blockedRooms.set(roomId, remaining)
    }
    this.wake()
  }

  /** Stable delivery IDs distinguish room turns from direct Chat/CLI turns. */
  confirmTurn(participantId: string, userMessage: RoomHarnessTurnUserMessage): RoomDelivery | null {
    return this.confirmations.confirm(participantId, userMessage)
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) {
      return
    }
    this.draining = true
    try {
      let repeat: boolean
      do {
        this.rerun = false
        let claimedAny = false
        const due = this.db.messages.deliveries.listDue(Date.now(), 100, [
          ...this.blockedRooms.keys()
        ])
        for (const candidate of due) {
          const roomId = this.db.messages.get(candidate.messageId).roomId
          if (this.blockedRooms.has(roomId)) {
            continue
          }
          const delivery = this.db.messages.deliveries.claim(candidate.id)
          if (!delivery) {
            continue
          }
          claimedAny = true
          // One slow harness must not block other participants' queues.
          const task = this.deliver(delivery)
          const roomTasks = this.inFlight.get(roomId) ?? new Set<Promise<void>>()
          roomTasks.add(task)
          this.inFlight.set(roomId, roomTasks)
          void task.finally(() => {
            roomTasks.delete(task)
            if (roomTasks.size === 0) {
              this.inFlight.delete(roomId)
            }
            this.wake()
          })
        }
        repeat = claimedAny || this.rerun
      } while (repeat)
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
      this.db.core.get(message.roomId)
      const initiallySuppressed = suppressPausedDelivery(this.db, delivery, target)
      if (initiallySuppressed) {
        return this.emit(target.roomId, { type: 'delivery.updated', delivery: initiallySuppressed })
      }
      // A second status probe would reject silent daemon-recovered PTYs.
      target = await this.ensureParticipantReady(target.id)
      this.assertCurrent(delivery)
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
      this.assertCurrent(delivery)
      const prompt = formatRoomDeliveryPrompt({
        deliveryId: delivery.id,
        attempt: delivery.attempts,
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
      this.confirmations.prepare(delivery.id, target.id, configuration.snapshot)
      delivery = this.db.messages.deliveries.setPhase(delivery.id, 'submitting')
      this.emit(message.roomId, { type: 'delivery.updated', delivery })
      const result = await adapter.send(binding, prompt, {
        beforeWrite: () => this.assertCurrent(delivery),
        clearInput: delivery.attempts > 1,
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
      this.confirmations.arm(delivery.id)
    } catch (error) {
      this.confirmations.discard(delivery.id)
      if (this.disposed) {
        return
      }
      const messageText = error instanceof Error ? error.message : String(error)
      const exhausted = delivery.attempts >= MAX_DELIVERY_ATTEMPTS
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

  private scheduleNext(): void {
    if (this.disposed || this.timer) {
      return
    }
    const nextDueAt = this.db.messages.deliveries.nextDueAt([...this.blockedRooms.keys()])
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

  private assertCurrent(delivery: RoomDelivery): void {
    const current = this.db.messages.deliveries.get(delivery.id)
    if (current.state !== 'delivering' || current.attempts !== delivery.attempts) {
      throw new Error('room_delivery_stopped')
    }
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
