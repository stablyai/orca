import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type {
  Room,
  RoomEvent,
  RoomMessage,
  RoomMessagePage,
  RoomParticipant,
  RoomSnapshot,
  RoomUnread
} from '../../../shared/rooms'
import { RoomDatabase } from './database'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RoomDeliveryWorker } from './delivery-worker'
import { createRoomHarnessAdapters, type RoomHarnessRuntime } from './harness-adapter'
import { RoomTranscriptBridge } from './transcript-bridge'
import { RoomParticipantController } from './participant-controller'
import { RoomArchive } from './archive'
import { RoomEventBus, type RoomListener } from './event-bus'
import { RoomMessageController, type SendRoomMessageInput } from './message-controller'
import { RoomArchiveTransferStore } from './archive-transfers'
import { RoomAttachmentManager } from './attachments'
import { RoomAttachmentTransferStore } from './attachment-transfers'
import { RoomDeletionCoordinator } from './room-deletion'
import { RoomWorkController } from './work-controller'
import { addRoomMessageNotificationContext } from './room-event-notification'

export type { RoomParticipantConnection } from './participant-controller'

export class RoomService {
  readonly db: RoomDatabase
  readonly archiveTransfers: RoomArchiveTransferStore
  readonly attachmentTransfers: RoomAttachmentTransferStore
  private readonly adapters
  private readonly deliveryWorker: RoomDeliveryWorker
  readonly transcriptBridge: RoomTranscriptBridge
  readonly participantController: RoomParticipantController
  private readonly events: RoomEventBus
  private readonly messageController: RoomMessageController
  private readonly focusTerminal: RoomHarnessRuntime['focusTerminal']
  private readonly hideRendererStatus: RoomHarnessRuntime['hideRoomAgentStatusFromRenderer']
  private readonly publishAgentSession: RoomHarnessRuntime['publishRoomAgentProviderSession']
  private readonly deletion: RoomDeletionCoordinator
  private readonly work: RoomWorkController

  constructor(path: string, runtime: RoomHarnessRuntime) {
    this.events = new RoomEventBus(runtime.emitRoomEvent?.bind(runtime))
    this.focusTerminal = runtime.focusTerminal?.bind(runtime)
    this.hideRendererStatus = runtime.hideRoomAgentStatusFromRenderer?.bind(runtime)
    this.publishAgentSession = runtime.publishRoomAgentProviderSession?.bind(runtime)
    this.db = new RoomDatabase(path)
    this.archiveTransfers = new RoomArchiveTransferStore(new RoomArchive(this.db))
    const attachmentRoot =
      path === ':memory:'
        ? join(tmpdir(), 'orca-room-attachments', randomUUID())
        : join(dirname(path), 'room-attachments')
    const attachments = new RoomAttachmentManager(attachmentRoot)
    this.attachmentTransfers = new RoomAttachmentTransferStore(this.db, attachments)
    this.adapters = createRoomHarnessAdapters(runtime)
    this.transcriptBridge = new RoomTranscriptBridge(
      this.db,
      this.adapters,
      (roomId, event) => this.emitEvent(roomId, event),
      (participantId, userMessage) => this.deliveryWorker.confirmTurn(participantId, userMessage),
      () => this.deliveryWorker.wake()
    )
    this.participantController = new RoomParticipantController(
      this.db,
      this.adapters,
      this.transcriptBridge,
      (roomId, event) => this.emitEvent(roomId, event),
      this.hideRendererStatus
    )
    this.deliveryWorker = new RoomDeliveryWorker(
      this.db,
      this.adapters,
      attachments,
      (roomId, event) => this.emitEvent(roomId, event),
      (participantId) => this.participantController.ensureReady(participantId)
    )
    this.messageController = new RoomMessageController(
      this.db,
      attachments,
      (roomId, event) => this.emitEvent(roomId, event),
      () => this.deliveryWorker.wake()
    )
    this.work = new RoomWorkController(
      this.db,
      this.deliveryWorker,
      this.transcriptBridge,
      this.adapters,
      (roomId, event) => this.emitEvent(roomId, event)
    )
    this.deletion = new RoomDeletionCoordinator(
      this.db,
      this.deliveryWorker,
      this.participantController,
      this.archiveTransfers,
      this.attachmentTransfers,
      this.events,
      runtime.cleanupDeletedRoomResources?.bind(runtime) ?? (async () => undefined)
    )
    this.deliveryWorker.start()
    this.participantController.startHibernationSweep()
    this.deletion.start()
  }

  close(): void {
    this.deletion.dispose()
    this.participantController.dispose()
    this.deliveryWorker.dispose()
    this.transcriptBridge.dispose()
    this.events.clear()
    this.archiveTransfers.clear()
    this.attachmentTransfers.clear()
    this.db.close()
  }

  createRoom(input: Parameters<RoomDatabase['createRoom']>[0]): RoomSnapshot {
    return this.db.createRoom(input)
  }

  listRooms(projectId: string): Room[] {
    return this.db.core.list(projectId)
  }

  snapshot(roomId: string, readerKey = 'user'): RoomSnapshot {
    return this.db.snapshot(roomId, readerKey)
  }

  async activateRoom(roomId: string, readerKey = 'user'): Promise<RoomSnapshot> {
    return this.deletion.run(roomId, () => this.activateRoomNow(roomId, readerKey))
  }

  private async activateRoomNow(roomId: string, readerKey: string): Promise<RoomSnapshot> {
    const snapshot = this.db.snapshot(roomId, readerKey)
    await Promise.all(
      snapshot.participants
        .filter((participant) => participant.actorKind === 'agent')
        .map(async (participant) => {
          // One unrecoverable agent must not block activating the rest of the room.
          try {
            const reconciled = await this.participantController.reconcile(participant)
            if (reconciled.state !== 'sleeping' && reconciled.state !== 'offline') {
              this.publishParticipantSession(reconciled)
              await this.transcriptBridge.ensure(reconciled)
              await this.transcriptBridge.refreshContext(reconciled)
            }
          } catch {}
        })
    )
    return this.db.snapshot(roomId, readerKey)
  }

  subscribe(roomId: string, readerKey: string, listener: RoomListener): () => void {
    void this.activateRoom(roomId, readerKey).catch(() => {})
    return this.events.subscribe(
      roomId,
      { type: 'snapshot', snapshot: this.db.snapshot(roomId, readerKey) },
      listener
    )
  }

  listMessages(roomId: string, beforeSequence: number | null, limit = 100): RoomMessagePage {
    return this.db.messages.list(roomId, beforeSequence, limit)
  }

  assertWritable(roomId: string): void {
    this.deletion.assertAvailable(roomId)
  }

  getUserParticipant(roomId: string): RoomParticipant {
    const participant = this.db.participants.list(roomId).find((item) => item.actorKind === 'user')
    if (!participant) {
      throw new Error('room_user_participant_required')
    }
    return participant
  }

  sendMessage(input: SendRoomMessageInput): Promise<RoomMessage> {
    return this.deletion.run(input.roomId, () => this.messageController.send(input))
  }

  updateMessage(id: string, senderIdentity: string, body: string): RoomMessage {
    this.assertWritable(this.db.messages.get(id).roomId)
    return this.messageController.update(id, senderIdentity, body)
  }

  async deleteMessage(id: string, senderIdentity: string): Promise<void> {
    const roomId = this.db.messages.get(id).roomId
    this.messageController.assertDeletable(id, senderIdentity)
    await this.deletion.run(roomId, async () => {
      await this.work.stopMessage(id)
      await this.messageController.delete(id, senderIdentity)
    })
  }

  markRead(roomId: string, readerKey: string, sequence: number): RoomUnread {
    this.assertWritable(roomId)
    return this.messageController.markRead(roomId, readerKey, sequence)
  }

  async addParticipant(
    input: Parameters<RoomParticipantController['add']>[0]
  ): Promise<RoomParticipant> {
    return this.deletion.run(input.roomId, () => this.participantController.add(input))
  }

  participantForTerminal(handle: string): RoomParticipant | null {
    return this.db.participants.findByTerminalHandle(handle)
  }

  participantForPane(paneKey: string): RoomParticipant | null {
    return this.db.participants.findByPaneKey(paneKey)
  }

  currentTurnDeliveryIdForPane(paneKey: string): string | null {
    const participant = this.participantForPane(paneKey)
    return participant ? this.transcriptBridge.currentTurnDeliveryId(participant.id) : null
  }

  async revealParticipant(id: string, viewMode: 'terminal' | 'chat'): Promise<void> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.revealParticipantNow(id, viewMode))
  }

  private async revealParticipantNow(id: string, viewMode: 'terminal' | 'chat'): Promise<void> {
    if (!this.focusTerminal) {
      throw new Error('room_participant_not_ready')
    }
    const participant = await this.participantController.ensureReady(id)
    if (!participant.terminalHandle) {
      throw new Error('room_participant_not_ready')
    }
    await this.focusTerminal(participant.terminalHandle, { viewMode })
    const revealed = this.db.participants.update(participant.id, {
      terminalHandle: participant.terminalHandle,
      paneKey: participant.paneKey,
      providerSession: participant.providerSession,
      terminalSurfaceVisible: true
    })
    this.publishParticipantSession(revealed, true)
  }

  hideParticipantTerminal(handle: string): void {
    const participant = this.db.participants.findByTerminalHandle(handle)
    if (participant?.terminalSurfaceVisible) {
      const hidden = this.db.participants.update(participant.id, { terminalSurfaceVisible: false })
      if (hidden.paneKey) {
        this.hideRendererStatus?.(hidden.paneKey)
      }
  }
  }

  private publishParticipantSession(
    { terminalHandle, agent, providerSession }: RoomParticipant,
    force = false
  ): void {
    if (terminalHandle && agent && providerSession) {
      this.publishAgentSession?.(terminalHandle, agent, providerSession, force)
    }
  }

  async removeParticipant(id: string): Promise<void> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.remove(id))
  }

  async compactParticipant(id: string): Promise<RoomParticipant> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.compact(id))
  }

  async controlParticipant(id: string, command: string): Promise<RoomParticipant> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.control(id, command))
  }

  async reconfigureParticipant(
    id: string,
    preferences: Parameters<RoomParticipantController['reconfigure']>[1]
  ): Promise<RoomParticipant> {
    const roomId = this.db.participants.get(id).roomId
    return this.deletion.run(roomId, () => this.participantController.reconfigure(id, preferences))
  }

  retryDelivery(id: string): void {
    const roomId = this.db.messages.get(this.db.messages.deliveries.get(id).messageId).roomId
    this.assertWritable(roomId)
    const delivery = this.db.messages.deliveries.retry(id)
    this.emitEvent(roomId, { type: 'delivery.updated', delivery })
    this.deliveryWorker.wake()
  }

  stopRoom = (roomId: string): Promise<number> =>
    this.deletion.run(roomId, () => this.work.stop(roomId))

  resumeRoom = (roomId: string): Promise<number> =>
    this.deletion.run(roomId, () => this.work.resume(roomId))

  recordAttachmentDrop(attachmentId: string, connectionId: string, remotePath: string): void {
    this.db.recordAttachmentDrop(attachmentId, connectionId, remotePath)
  }

  deleteRoom(roomId: string): Promise<void> {
    return this.deletion.delete(roomId)
  }

  finishArchiveImport(transferId: string) {
    const roomId = this.archiveTransfers.importRoomId(transferId)
    return this.deletion.run(roomId, () => this.archiveTransfers.finishImport(transferId))
  }

  startArchiveExport(roomId: string, fileName: string) {
    return this.deletion.run(roomId, () => this.archiveTransfers.startExport(roomId, fileName))
  }

  startAttachmentUpload(roomId: string, fileName: string, byteSize: number) {
    return this.deletion.run(roomId, () =>
      this.attachmentTransfers.startUpload(roomId, fileName, byteSize)
    )
  }

  startAttachmentDownload(roomId: string, attachmentId: string) {
    return this.deletion.run(roomId, () =>
      this.attachmentTransfers.startDownload(roomId, attachmentId)
    )
  }

  ingestAgentStatus(event: AgentHookEventPayload & { receivedAt: number }): void {
    this.participantController.ingestStatus(event)
  }

  ingestClaudeStatusLine(event: ClaudeStatusLineRateLimits): void {
    this.participantController.ingestClaudeStatusLine(event)
  }

  emitEvent(roomId: string, event: RoomEvent): void {
    if (event.type === 'delivery.updated') {
      event = { ...event, workState: this.db.messages.deliveries.workState(roomId) }
    }
    this.events.emit(roomId, addRoomMessageNotificationContext(this.db, roomId, event))
  }
}
