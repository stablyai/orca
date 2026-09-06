import type { RoomDelivery, RoomEvent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter } from './harness-adapter'
import type { RoomHarnessTurnUserMessage } from './harness-lifecycle'
import type { RoomAttachmentManager } from './attachments'
import { RoomDeliveryConfirmations } from './delivery-confirmations'
import { claimReadyRoomDelivery } from './delivery-machine-readiness'
import { runRoomSteer } from './delivery-steer-selection'
import { claimReadyRoomBroadcast } from './delivery-broadcast-dispatch'
import { scheduleRoomDeliveryDrain } from './delivery-scheduler'
import { RoomDeliveryGate, type RoomDeliveryFence } from './delivery-room-gate'
import { runRoomAutoSteer } from './delivery-auto-steer'
import { deliverRoomDelivery } from './delivery-execution'

export class RoomDeliveryWorker {
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  private rerun = false
  private disposed = false
  private readonly confirmations: RoomDeliveryConfirmations
  private readonly gate = new RoomDeliveryGate()
  private busyRetryAt = 0

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<string, RoomHarnessAdapter>,
    private readonly attachments: RoomAttachmentManager,
    private readonly emit: (roomId: string, event: RoomEvent) => void,
    private readonly ensureParticipantReady: (participantId: string) => Promise<RoomParticipant>,
    confirmDeadlineMs = 30_000,
    private readonly liveSteeringEnabled: () => boolean = () => false
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
    this.gate.dispose()
  }

  requestRoomFence(
    roomId: string,
    options: { discardConfirmations: boolean; waitForTasks?: boolean }
  ): RoomDeliveryFence {
    const fence = this.gate.requestFence(roomId, options.waitForTasks)
    return {
      ready: fence.ready.then((acquired) => {
        if (acquired && options.discardConfirmations) {
          this.confirmations.clearRoom(roomId)
        }
      }),
      claimAllowed: fence.claimAllowed,
      release: () => {
        fence.release()
        this.wake()
      }
    }
  }

  /** Stable delivery IDs distinguish room turns from direct Chat/CLI turns. */
  confirmTurn(participantId: string, userMessage: RoomHarnessTurnUserMessage): RoomDelivery | null {
    return this.confirmations.confirm(participantId, userMessage)
  }

  async steer(id: string, group = false): Promise<void> {
    return runRoomSteer(
      this.db,
      this.adapters,
      id,
      this.requestRoomFence.bind(this),
      this.deliver.bind(this),
      this.track.bind(this),
      group
    )
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) {
      return
    }
    this.draining = true
    try {
      const { db, adapters, ensureParticipantReady } = this
      let repeat: boolean
      do {
        this.rerun = false
        let claimedAny = false
        let busyCandidate = false
        if (this.liveSteeringEnabled()) {
          const autoSteer = await runRoomAutoSteer(
            this.db,
            this.adapters,
            this.gate.blockedRoomIds(),
            this.requestRoomFence.bind(this),
            (delivery, steer) => this.deliver(delivery, steer, false),
            this.track.bind(this)
          )
          claimedAny = autoSteer.claimedAny
          busyCandidate = autoSteer.busyCandidate
        }
        const due = this.db.messages.deliveries.listDue(Date.now(), 100, this.gate.blockedRoomIds())
        const handledBroadcasts = new Set<string>()
        for (const candidate of due) {
          const roomId = this.db.messages.get(candidate.messageId).roomId
          if (!this.gate.claimAllowed(roomId)) {
            continue
          }
          if (this.db.messages.deliveries.workState(roomId) === 'stopped') {
            busyCandidate = true
            continue
          }
          if (this.db.messages.deliveries.isInitialBroadcastDispatch(candidate.messageId)) {
            if (handledBroadcasts.has(candidate.messageId)) {
              continue
            }
            handledBroadcasts.add(candidate.messageId)
            const claimed = await this.gate.startClaim(
              roomId,
              () =>
                claimReadyRoomBroadcast(
                  db,
                  adapters,
                  candidate.messageId,
                  ensureParticipantReady,
                  () => this.gate.claimAllowed(roomId)
                ),
              (delivery) => void this.track(roomId, () => this.deliver(delivery))
            )
            if (!claimed) {
              busyCandidate = true
              continue
            }
            claimedAny = true
            continue
          }
          const claimed = await this.gate.startClaim(
            roomId,
            async () => {
              const delivery = await claimReadyRoomDelivery(
                db,
                adapters,
                candidate,
                ensureParticipantReady,
                () => this.gate.claimAllowed(roomId)
              )
              return delivery ? [delivery] : null
            },
            (delivery) => void this.track(roomId, () => this.deliver(delivery))
          )
          if (!claimed) {
            busyCandidate = true
            continue
          }
          claimedAny = true
        }
        if (!claimedAny && busyCandidate) {
          this.busyRetryAt = Date.now() + 250
        }
        repeat = claimedAny || this.rerun
      } while (repeat)
    } finally {
      this.draining = false
      this.scheduleNext()
    }
  }

  private async deliver(
    delivery: RoomDelivery,
    steer = false,
    moveRejectedSteerToHead = true
  ): Promise<void> {
    return deliverRoomDelivery({
      db: this.db,
      adapters: this.adapters,
      attachments: this.attachments,
      confirmations: this.confirmations,
      emit: this.emit,
      ensureParticipantReady: this.ensureParticipantReady,
      delivery,
      steer,
      moveRejectedSteerToHead,
      disposed: () => this.disposed
    })
  }

  private async track(roomId: string, run: () => Promise<void>): Promise<void> {
    try {
      await this.gate.startTask(roomId, run)
    } finally {
      this.wake()
    }
  }

  private scheduleNext(): void {
    scheduleRoomDeliveryDrain(
      this.db,
      this.gate.blockedRoomIds(),
      this.busyRetryAt,
      this.disposed,
      this.timer,
      (timer) => (this.timer = timer),
      () => {
        this.timer = null
        void this.drain()
      }
    )
  }
}
