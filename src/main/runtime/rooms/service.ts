import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import type {
  Room,
  RoomAttachableAgent,
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
import { addRoomMessageNotificationContext } from './room-event-notification'

export type { RoomParticipantConnection } from './participant-controller'

export class RoomService {
  readonly db: RoomDatabase
  readonly archiveTransfers: RoomArchiveTransferStore
  readonly attachmentTransfers: RoomAttachmentTransferStore
  private readonly adapters
  private readonly deliveryWorker: RoomDeliveryWorker
  private readonly transcriptBridge: RoomTranscriptBridge
  readonly participantController: RoomParticipantController
  private readonly events: RoomEventBus
  private readonly messageController: RoomMessageController
  private readonly listAttachable: RoomHarnessRuntime['listRoomAttachableAgents']
  private readonly focusTerminal: RoomHarnessRuntime['focusTerminal']
  private readonly publishAgentSession: RoomHarnessRuntime['publishRoomAgentProviderSession']

  constructor(path: string, runtime: RoomHarnessRuntime) {
    this.events = new RoomEventBus(runtime.emitRoomEvent?.bind(runtime))
    this.listAttachable = runtime.listRoomAttachableAgents.bind(runtime)
    this.focusTerminal = runtime.focusTerminal?.bind(runtime)
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
      (roomId, event) => this.emitEvent(roomId, event)
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
    this.deliveryWorker.start()
    this.participantController.startHibernationSweep()
  }

  close(): void {
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

  listRooms(projectId: string, includeArchived = false): Room[] {
    return this.db.core.list(projectId, includeArchived)
  }

  listAttachableAgents(worktreeId: string): Promise<RoomAttachableAgent[]> {
    return this.listAttachable(worktreeId)
  }

  snapshot(roomId: string, readerKey = 'user'): RoomSnapshot {
    return this.db.snapshot(roomId, readerKey)
  }

  async activateRoom(roomId: string, readerKey = 'user'): Promise<RoomSnapshot> {
    const snapshot = this.db.snapshot(roomId, readerKey)
    if (snapshot.room.archivedAt) {
      return snapshot
    }
    await Promise.all(
      snapshot.participants
        .filter((participant) => participant.actorKind === 'agent')
        .map(async (participant) => {
          // One unrecoverable agent must not block activating the rest of the room.
          try {
            const reconciled = await this.participantController.reconcile(participant)
            this.publishParticipantSession(reconciled)
            await this.transcriptBridge.ensure(reconciled)
            await this.transcriptBridge.refreshContext(reconciled)
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
    if (this.db.core.get(roomId).archivedAt) {
      throw new Error('room_archived')
    }
  }

  getUserParticipant(roomId: string): RoomParticipant {
    const participant = this.db.participants.list(roomId).find((item) => item.actorKind === 'user')
    if (!participant) {
      throw new Error('room_user_participant_required')
    }
    return participant
  }

  setArchived(roomId: string, archived: boolean): Room {
    const changes = this.db.transaction(() => ({
      room: this.db.core.update(roomId, { archived }),
      deliveries: archived
        ? this.db.messages.deliveries.deferRoom(roomId)
        : this.db.messages.deliveries.resumeRoom(roomId)
    }))
    const { room } = changes
    this.emitEvent(room.id, { type: 'room.updated', room })
    if (archived) {
      for (const delivery of changes.deliveries) {
        this.emitEvent(room.id, { type: 'delivery.updated', delivery })
      }
      for (const participant of this.db.participants.list(room.id)) {
        this.transcriptBridge.disposeParticipant(participant.id)
      }
    } else {
      for (const delivery of changes.deliveries) {
        this.emitEvent(room.id, { type: 'delivery.updated', delivery })
      }
      for (const participant of this.db.participants.listBound(room.id)) {
        this.db.providerMessages.resetStream(participant.id)
        void this.transcriptBridge.ensure(participant).catch(() => {})
        void this.transcriptBridge.refreshContext(participant).catch(() => {})
      }
      this.deliveryWorker.wake()
    }
    return room
  }

  sendMessage(input: SendRoomMessageInput): Promise<RoomMessage> {
    return this.messageController.send(input)
  }

  updateMessage(id: string, senderIdentity: string, body: string): RoomMessage {
    return this.messageController.update(id, senderIdentity, body)
  }

  async deleteMessage(id: string, senderIdentity: string): Promise<void> {
    await this.messageController.delete(id, senderIdentity)
  }

  markRead(roomId: string, readerKey: string, sequence: number): RoomUnread {
    return this.messageController.markRead(roomId, readerKey, sequence)
  }

  async addParticipant(
    input: Parameters<RoomParticipantController['add']>[0]
  ): Promise<RoomParticipant> {
    return this.participantController.add(input)
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
    const participant = this.db.participants.get(id)
    if (!participant.terminalHandle || !this.focusTerminal) {
      throw new Error('room_participant_not_ready')
    }
    this.publishParticipantSession(participant)
    await this.focusTerminal(participant.terminalHandle, { viewMode })
  }

  private publishParticipantSession({
    terminalHandle,
    agent,
    providerSession
  }: RoomParticipant): void {
    if (terminalHandle && agent && providerSession) {
      this.publishAgentSession?.(terminalHandle, agent, providerSession)
    }
  }

  async removeParticipant(id: string): Promise<void> {
    return this.participantController.remove(id)
  }

  async compactParticipant(id: string): Promise<RoomParticipant> {
    this.assertWritable(this.db.participants.get(id).roomId)
    return this.participantController.compact(id)
  }

  async controlParticipant(id: string, command: string): Promise<RoomParticipant> {
    this.assertWritable(this.db.participants.get(id).roomId)
    return this.participantController.control(id, command)
  }

  async reconfigureParticipant(
    id: string,
    preferences: Parameters<RoomParticipantController['reconfigure']>[1]
  ): Promise<RoomParticipant> {
    this.assertWritable(this.db.participants.get(id).roomId)
    return this.participantController.reconfigure(id, preferences)
  }

  retryDelivery(id: string): void {
    const roomId = this.db.messages.get(this.db.messages.deliveries.get(id).messageId).roomId
    this.assertWritable(roomId)
    const delivery = this.db.messages.deliveries.retry(id)
    this.emitEvent(roomId, { type: 'delivery.updated', delivery })
    this.deliveryWorker.wake()
  }

  ingestAgentStatus(event: AgentHookEventPayload & { receivedAt: number }): void {
    this.participantController.ingestStatus(event)
  }

  ingestClaudeStatusLine(event: ClaudeStatusLineRateLimits): void {
    this.participantController.ingestClaudeStatusLine(event)
  }

  emitEvent(roomId: string, event: RoomEvent): void {
    this.events.emit(roomId, addRoomMessageNotificationContext(this.db, roomId, event))
  }
}
